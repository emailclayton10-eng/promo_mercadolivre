import { tx, now, getSettings } from '../db.js';
import { pool } from './jobs.js';

const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

export function extractSku(item) {
  const attr = (list) => list?.find((a) => a.id === 'SELLER_SKU')?.value_name;
  const own = item.seller_custom_field || attr(item.attributes);
  if (own) return own.trim();
  const vars = new Set((item.variations || []).map((v) => v.seller_custom_field || attr(v.attributes)).filter(Boolean));
  return vars.size ? [...vars].join(',') : null;
}

export async function syncListings({ db, ml, concurrency, job }) {
  const settings = getSettings(db);
  const syncedAt = now();

  job.step('Buscando IDs dos anúncios');
  const ids = [];
  for (const status of settings.sync_statuses) {
    for await (const page of ml.scanItemIds(status)) {
      ids.push(...page.ids);
      job.step(`Buscando IDs dos anúncios (${ids.length})`);
    }
  }

  const upsert = db.prepare(`
    INSERT INTO listings(id, title, price, original_price, status, listing_type_id, category_id, sku, thumbnail, permalink,
                         available_quantity, free_shipping, logistic_type, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET title = excluded.title, price = excluded.price, original_price = excluded.original_price,
      status = excluded.status, listing_type_id = excluded.listing_type_id, category_id = excluded.category_id, sku = excluded.sku,
      thumbnail = excluded.thumbnail, permalink = excluded.permalink, available_quantity = excluded.available_quantity,
      free_shipping = excluded.free_shipping, logistic_type = excluded.logistic_type, synced_at = excluded.synced_at`);

  const batches = chunk(ids, 20);
  job.setTotal(batches.length);
  job.step(`Importando ${ids.length} anúncios`);
  await pool(batches, concurrency, async (batch) => {
    try {
      const items = await ml.getItems(batch);
      tx(db, () => {
        for (const it of items) {
          upsert.run(
            it.id, it.title, it.price, it.original_price ?? null, it.status, it.listing_type_id, it.category_id, extractSku(it),
            it.thumbnail ?? null, it.permalink ?? null, it.available_quantity ?? null, it.shipping?.free_shipping ? 1 : 0,
            it.shipping?.logistic_type ?? null, syncedAt
          );
        }
      });
      job.ok();
    } catch (e) {
      job.fail(`Lote ${batch[0]}…: ${e.message}`);
    }
  });

  // Anúncios que não vieram mais na busca (encerrados/excluídos)
  if (!job.failed) db.prepare("UPDATE listings SET status = 'closed' WHERE synced_at IS NOT ? AND status <> 'closed'").run(syncedAt);

  await syncFees({ db, ml, concurrency, job });
  if (settings.fetch_shipping_costs) await syncShippingCosts({ db, ml, concurrency, job });
  ml.markSynced('listings');
  job.step(`${ids.length} anúncios sincronizados`);
}

/** Comissão (%) por categoria + tipo de anúncio. Poucas chamadas, pois se repetem entre anúncios. */
export async function syncFees({ db, ml, concurrency, job, maxAgeDays = 7 }) {
  const pairs = db
    .prepare(
      `SELECT DISTINCT l.category_id, l.listing_type_id FROM listings l
       LEFT JOIN fee_rates f ON f.category_id = l.category_id AND f.listing_type_id = l.listing_type_id
       WHERE l.status <> 'closed' AND l.category_id IS NOT NULL AND l.listing_type_id IS NOT NULL
         AND (f.updated_at IS NULL OR f.updated_at < ?)`
    )
    .all(new Date(Date.now() - maxAgeDays * 86400000).toISOString());
  if (!pairs.length) return;
  job.addTotal(pairs.length);
  job.step(`Consultando tarifas de ${pairs.length} categorias`);
  const up = db.prepare(
    `INSERT INTO fee_rates(category_id, listing_type_id, percent, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT DO UPDATE SET percent = excluded.percent, updated_at = excluded.updated_at`
  );
  await pool(pairs, concurrency, async (p) => {
    try {
      const pct = await ml.listingFeePercent(p.category_id, p.listing_type_id);
      if (pct !== null) up.run(p.category_id, p.listing_type_id, pct, now());
      job.ok();
    } catch (e) {
      job.fail(`Tarifa ${p.category_id}/${p.listing_type_id}: ${e.message}`);
    }
  });
}

/** Custo do frete grátis pago pelo vendedor, por anúncio. */
export async function syncShippingCosts({ db, ml, concurrency, job, maxAgeDays = 7, force = false }) {
  const rows = db
    .prepare(
      `SELECT id FROM listings WHERE status <> 'closed' AND free_shipping = 1
         AND (? OR shipping_updated_at IS NULL OR shipping_updated_at < ?)`
    )
    .all(force ? 1 : 0, new Date(Date.now() - maxAgeDays * 86400000).toISOString());
  if (!rows.length) return;
  job.addTotal(rows.length);
  job.step(`Consultando frete de ${rows.length} anúncios`);
  const up = db.prepare('UPDATE listings SET shipping_cost = ?, shipping_updated_at = ? WHERE id = ?');
  await pool(rows, concurrency, async ({ id }) => {
    try {
      const cost = await ml.freeShippingCost(id);
      up.run(cost, now(), id);
      job.ok();
    } catch (e) {
      job.fail(`Frete ${id}: ${e.message}`);
    }
  });
}

export async function syncPromotions({ db, ml, concurrency, job, withItems = true }) {
  job.step('Buscando campanhas');
  const promos = await ml.listPromotions();
  const syncedAt = now();
  const up = db.prepare(`
    INSERT INTO promotions(id, type, name, status, start_date, finish_date, deadline_date, benefits, raw, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET type = excluded.type, name = excluded.name, status = excluded.status,
      start_date = excluded.start_date, finish_date = excluded.finish_date, deadline_date = excluded.deadline_date,
      benefits = excluded.benefits, raw = excluded.raw, synced_at = excluded.synced_at`);
  tx(db, () => {
    for (const p of promos) {
      up.run(
        String(p.id), p.type, p.name ?? null, p.status ?? null, p.start_date ?? null, p.finish_date ?? null,
        p.deadline_date ?? null, p.benefits ? JSON.stringify(p.benefits) : null, JSON.stringify(p), syncedAt
      );
    }
    // Campanhas que deixaram de existir
    db.prepare('DELETE FROM promotions WHERE synced_at IS NOT ?').run(syncedAt);
  });
  ml.markSynced('promotions');
  if (!withItems) return;
  job.setTotal(promos.length);
  await pool(promos, Math.min(concurrency, 3), async (p) => {
    try {
      const n = await syncPromotionItems({ db, ml, promotionId: String(p.id), promotionType: p.type });
      job.ok(`${p.name || p.id}: ${n} anúncios`);
    } catch (e) {
      job.fail(`${p.name || p.id}: ${e.message}`);
    }
  });
  job.step(`${promos.length} campanhas sincronizadas`);
}

export async function syncPromotionItems({ db, ml, promotionId, promotionType, job }) {
  const syncedAt = now();
  const rows = [];
  for await (const page of ml.promotionItems(promotionId, promotionType)) {
    rows.push(...page);
    job?.step(`Carregando anúncios da campanha (${rows.length})`);
  }
  const up = db.prepare(`
    INSERT INTO promotion_items(promotion_id, listing_id, status, price, original_price, min_discounted_price, max_discounted_price,
      suggested_discounted_price, meli_percentage, seller_percentage, offer_id, raw, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(promotion_id, listing_id) DO UPDATE SET status = excluded.status, price = excluded.price,
      original_price = excluded.original_price, min_discounted_price = excluded.min_discounted_price,
      max_discounted_price = excluded.max_discounted_price, suggested_discounted_price = excluded.suggested_discounted_price,
      meli_percentage = excluded.meli_percentage, seller_percentage = excluded.seller_percentage, offer_id = excluded.offer_id,
      raw = excluded.raw, updated_at = excluded.updated_at`);
  tx(db, () => {
    for (const r of rows) {
      up.run(
        promotionId, r.id, r.status ?? null, r.price ?? null, r.original_price ?? null, r.min_discounted_price ?? null,
        r.max_discounted_price ?? null, r.suggested_discounted_price ?? null, r.meli_percentage ?? null,
        r.seller_percentage ?? null, r.offer_id ?? null, JSON.stringify(r), syncedAt
      );
    }
    db.prepare('DELETE FROM promotion_items WHERE promotion_id = ? AND updated_at IS NOT ?').run(promotionId, syncedAt);
    db.prepare('UPDATE promotions SET items_synced_at = ? WHERE id = ?').run(syncedAt, promotionId);
  });
  return rows.length;
}
