import { getSettings, now } from '../db.js';
import { buildContext, profitAt, isViable, minViablePrice, discountPercent, round2, floor2 } from './pricing.js';
import { pool } from './jobs.js';

export const PROMOTION_TYPES = {
  DEAL: 'Campanha tradicional',
  MARKETPLACE_CAMPAIGN: 'Campanha co-participada',
  SELLER_CAMPAIGN: 'Campanha do vendedor',
  LIGHTNING: 'Oferta relâmpago',
  DOD: 'Oferta do dia',
  SMART: 'Campanha automatizada',
  PRICE_MATCHING: 'Preço competitivo',
  PRICE_MATCHING_MELI_ALL: 'Preço competitivo (ML)',
  UNHEALTHY_STOCK: 'Liquidação de estoque Full',
  PRE_NEGOTIATED: 'Desconto pré-negociado',
  VOLUME: 'Desconto por volume',
  SELLER_COUPON_CAMPAIGN: 'Cupom do vendedor',
};

/** Tipos em que o vendedor escolhe o preço promocional (dentro da faixa permitida). */
export const PRICE_SETTABLE = new Set(['DEAL', 'SELLER_CAMPAIGN', 'LIGHTNING', 'DOD']);

export const STRATEGIES = {
  percent: 'Percentual geral',
  max_viable: 'Maior desconto viável',
  suggested: 'Preço sugerido pela campanha',
};

const ACTIVE_STATUSES = new Set(['started', 'pending', 'programmed']);

/** Linhas de itens da campanha com custos agregados do anúncio. */
function loadRows(db, promotionId) {
  return db
    .prepare(
      `SELECT pi.*, l.title, l.thumbnail, l.permalink, l.price AS listing_price, l.status AS listing_status,
              l.available_quantity, l.free_shipping, l.shipping_cost, l.shipping_cost_override, l.fee_percent_override,
              f.percent AS fee_percent, lc.cost, lc.min_profit, lc.min_margin_percent, lc.products
       FROM promotion_items pi
       LEFT JOIN listings l ON l.id = pi.listing_id
       LEFT JOIN fee_rates f ON f.category_id = l.category_id AND f.listing_type_id = l.listing_type_id
       LEFT JOIN listing_costs lc ON lc.listing_id = pi.listing_id
       WHERE pi.promotion_id = ?`
    )
    .all(promotionId);
}

/**
 * Calcula, para um item candidato, o preço alvo conforme a estratégia e se é viável.
 */
export function evaluateRow(promo, row, ctx, { strategy = 'percent', percent = 10 } = {}) {
  const original = row.original_price || row.listing_price || row.price;
  const minAllowed = row.min_discounted_price ?? null;
  const maxAllowed = row.max_discounted_price ?? null;
  const settable = PRICE_SETTABLE.has(promo.type);
  const participating = ACTIVE_STATUSES.has(row.status);
  const minViable = minViablePrice(ctx);
  const notes = [];

  let target;
  let received;
  if (participating) {
    target = row.price;
  } else if (settable) {
    if (strategy === 'max_viable') {
      target = minViable === null ? null : Math.max(minViable, minAllowed ?? 0);
      if (target !== null && maxAllowed !== null && target > maxAllowed) {
        notes.push('custo não permite o desconto mínimo exigido');
        target = maxAllowed;
      }
    } else if (strategy === 'suggested') {
      target = row.suggested_discounted_price ?? maxAllowed ?? original;
    } else {
      target = floor2(original * (1 - percent / 100));
    }
    if (target !== null) {
      if (maxAllowed !== null && target > maxAllowed) {
        target = maxAllowed;
        notes.push('ajustado ao desconto mínimo da campanha');
      }
      if (minAllowed !== null && target < minAllowed) {
        target = minAllowed;
        notes.push('ajustado ao desconto máximo da campanha');
      }
    }
  } else {
    // Preço definido pela campanha
    target = row.price && row.price < original ? row.price : row.suggested_discounted_price ?? row.price;
  }

  // Campanhas co-participadas: o ML cobre parte do desconto
  if (target !== null && row.meli_percentage && row.seller_percentage !== null && row.seller_percentage !== undefined) {
    received = round2(original * (1 - row.seller_percentage / 100));
  } else {
    received = target;
  }

  let result = null;
  let viable = false;
  let reason = '';
  if (!ctx.linked) {
    reason = 'sem produto vinculado';
  } else if (target === null || target === undefined) {
    reason = 'custo acima de qualquer preço possível';
  } else {
    result = profitAt(target, ctx, received);
    viable = isViable(result, ctx);
    if (!viable) {
      if (result.profit < ctx.minProfit) reason = `lucro líquido abaixo do mínimo (R$ ${ctx.minProfit.toFixed(2).replace('.', ',')})`;
      else reason = `margem líquida abaixo do mínimo (${ctx.minMarginPercent}%)`;
    }
  }

  return {
    listing_id: row.listing_id,
    title: row.title || '(anúncio não importado)',
    thumbnail: row.thumbnail,
    permalink: row.permalink,
    status: row.status,
    participating,
    products: row.products,
    available_quantity: row.available_quantity,
    cost: ctx.linked ? round2(ctx.cost) : null,
    original_price: original,
    min_allowed: minAllowed,
    max_allowed: maxAllowed,
    meli_percentage: row.meli_percentage,
    seller_percentage: row.seller_percentage,
    target_price: target === null ? null : round2(target),
    received: received === null || received === undefined ? null : round2(received),
    net: target === null || target === undefined ? null : profitAt(target, ctx, received).net,
    discount: target ? discountPercent(original, target) : null,
    profit: result?.profit ?? null,
    margin: result?.margin ?? null,
    fee: result?.fee ?? null,
    shipping: result?.shipping ?? null,
    min_viable_price: minViable,
    max_viable_discount: minViable ? Math.max(0, discountPercent(original, minViable)) : null,
    viable,
    reason: [reason, ...notes].filter(Boolean).join('; '),
  };
}

export function evaluatePromotion(db, promotionId, opts = {}) {
  const promo = db.prepare('SELECT * FROM promotions WHERE id = ?').get(promotionId);
  if (!promo) return null;
  const settings = getSettings(db);
  const rows = loadRows(db, promotionId).map((row) => evaluateRow(promo, row, buildContext(row, settings), opts));
  const summary = {
    total: rows.length,
    participating: rows.filter((r) => r.participating).length,
    viable: rows.filter((r) => !r.participating && r.viable).length,
    not_viable: rows.filter((r) => !r.participating && !r.viable && r.cost !== null).length,
    unlinked: rows.filter((r) => r.cost === null).length,
  };
  return { promo: { ...promo, type_label: PROMOTION_TYPES[promo.type] || promo.type, settable: PRICE_SETTABLE.has(promo.type) }, rows, summary };
}

export function filterRows(rows, { filter = 'all', search = '' } = {}) {
  const s = search.trim().toLowerCase();
  return rows.filter((r) => {
    if (filter === 'viable' && !(r.viable && !r.participating)) return false;
    if (filter === 'not_viable' && (r.viable || r.participating || r.cost === null)) return false;
    if (filter === 'unlinked' && r.cost !== null) return false;
    if (filter === 'participating' && !r.participating) return false;
    if (filter === 'candidate' && r.participating) return false;
    if (s && !(`${r.listing_id} ${r.title} ${r.products || ''}`.toLowerCase().includes(s))) return false;
    return true;
  });
}

export function buildAddPayload(promo, row, raw) {
  const base = { promotion_id: promo.id, promotion_type: promo.type };
  switch (promo.type) {
    case 'DEAL':
    case 'SELLER_CAMPAIGN':
    case 'DOD':
      return { ...base, deal_price: row.target_price };
    case 'LIGHTNING': {
      const avail = row.available_quantity ?? 1;
      const min = raw?.stock?.min ?? 1;
      const max = raw?.stock?.max ?? avail;
      return { ...base, deal_price: row.target_price, stock: Math.max(min, Math.min(max, avail)) };
    }
    case 'SMART':
    case 'PRICE_MATCHING':
    case 'PRICE_MATCHING_MELI_ALL':
    case 'UNHEALTHY_STOCK':
    case 'PRE_NEGOTIATED':
      return { ...base, offer_id: raw?.offer_id };
    default:
      return base;
  }
}

/**
 * Inclui anúncios em uma ou mais campanhas.
 * listingIds: se informado, restringe aos anúncios escolhidos; onlyViable: pula os inviáveis.
 */
export async function applyToPromotions({ db, ml, concurrency, job, promotionIds, strategy, percent, listingIds, onlyViable = true }) {
  const tasks = [];
  const skipped = { notViable: 0, participating: 0 };
  const wanted = listingIds?.length ? new Set(listingIds) : null;
  for (const pid of promotionIds) {
    const ev = evaluatePromotion(db, pid, { strategy, percent });
    if (!ev) continue;
    for (const r of ev.rows) {
      if (wanted && !wanted.has(r.listing_id)) continue;
      if (r.participating) {
        skipped.participating++;
        continue;
      }
      if (!r.viable && (onlyViable || r.cost === null || r.target_price === null)) {
        skipped.notViable++;
        continue;
      }
      tasks.push({ promo: ev.promo, row: r });
    }
  }
  job.setTotal(tasks.length);
  job.step(`Incluindo ${tasks.length} anúncios` + (skipped.notViable ? ` (${skipped.notViable} inviáveis ignorados)` : ''));

  const rawStmt = db.prepare('SELECT raw FROM promotion_items WHERE promotion_id = ? AND listing_id = ?');
  const upd = db.prepare('UPDATE promotion_items SET status = ?, price = ?, updated_at = ? WHERE promotion_id = ? AND listing_id = ?');
  await pool(tasks, concurrency, async ({ promo, row }) => {
    const raw = JSON.parse(rawStmt.get(promo.id, row.listing_id)?.raw || '{}');
    const payload = buildAddPayload(promo, row, raw);
    try {
      const res = await ml.addItemToPromotion(row.listing_id, payload);
      upd.run(res?.status || (promo.status === 'started' ? 'started' : 'pending'), res?.price ?? row.target_price, now(), promo.id, row.listing_id);
      job.ok(`${row.listing_id} → ${promo.name || promo.id} por R$ ${row.target_price?.toFixed(2)} (${row.discount}% off)`);
    } catch (e) {
      job.fail(`${row.listing_id} → ${promo.name || promo.id}: ${e.message}`);
    }
  });
  job.step(`${job.done - job.failed} incluídos, ${job.failed} com erro` + (skipped.notViable ? `, ${skipped.notViable} inviáveis ignorados` : ''));
}

export async function removeFromPromotion({ db, ml, concurrency, job, promotionId, listingIds }) {
  const promo = db.prepare('SELECT * FROM promotions WHERE id = ?').get(promotionId);
  if (!promo) throw new Error('Campanha não encontrada');
  const rows = db
    .prepare(`SELECT listing_id, offer_id, original_price FROM promotion_items WHERE promotion_id = ? AND status IN ('started','pending','programmed')`)
    .all(promotionId)
    .filter((r) => !listingIds?.length || listingIds.includes(r.listing_id));
  job.setTotal(rows.length);
  const upd = db.prepare("UPDATE promotion_items SET status = 'candidate', price = original_price, updated_at = ? WHERE promotion_id = ? AND listing_id = ?");
  await pool(rows, concurrency, async (r) => {
    try {
      await ml.removeItemFromPromotion(r.listing_id, { promotion_type: promo.type, promotion_id: promo.id, offer_id: r.offer_id || undefined });
      upd.run(now(), promotionId, r.listing_id);
      job.ok(`${r.listing_id} removido`);
    } catch (e) {
      job.fail(`${r.listing_id}: ${e.message}`);
    }
  });
}

export function listPromotions(db) {
  return db
    .prepare(
      `SELECT p.id, p.type, p.name, p.status, p.start_date, p.finish_date, p.deadline_date, p.benefits, p.items_synced_at,
              COUNT(pi.listing_id) AS items,
              SUM(CASE WHEN pi.status IN ('started','pending','programmed') THEN 1 ELSE 0 END) AS participating,
              SUM(CASE WHEN pi.status = 'candidate' THEN 1 ELSE 0 END) AS candidates
       FROM promotions p LEFT JOIN promotion_items pi ON pi.promotion_id = p.id
       GROUP BY p.id ORDER BY COALESCE(p.deadline_date, p.finish_date)`
    )
    .all()
    .map((p) => ({ ...p, type_label: PROMOTION_TYPES[p.type] || p.type, settable: PRICE_SETTABLE.has(p.type), benefits: p.benefits ? JSON.parse(p.benefits) : null }));
}

