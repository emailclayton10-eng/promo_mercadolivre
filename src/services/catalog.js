import { tx, getSettings } from '../db.js';
import { buildContext, minViablePrice, discountPercent, profitAt } from './pricing.js';

// ---------- CSV ----------

export function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/, 1)[0];
  const delim = [';', '\t', ','].map((d) => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === delim) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const clean = rows.filter((r) => r.some((v) => v.trim() !== ''));
  if (!clean.length) return [];
  const norm = (h) => h.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const headers = clean[0].map(norm);
  return clean.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()])));
}

export function parseNum(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v).trim().replace(/[R$\s%]/g, '');
  if (!s) return null;
  if (s.includes(',') && s.includes('.')) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (s.includes(',')) s = s.replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const pickField = (row, names) => {
  for (const n of names) if (row[n] !== undefined && row[n] !== '') return row[n];
  return undefined;
};

// ---------- Produtos ----------

export function listProducts(db, { search = '', page = 1, pageSize = 50 } = {}) {
  const like = `%${search.trim()}%`;
  const where = 'WHERE p.sku LIKE ? OR p.name LIKE ?';
  const total = db.prepare(`SELECT COUNT(*) n FROM products p ${where}`).get(like, like).n;
  const rows = db
    .prepare(
      `SELECT p.*, (SELECT COUNT(*) FROM listing_products lp WHERE lp.product_id = p.id) AS listings
       FROM products p ${where} ORDER BY p.sku LIMIT ? OFFSET ?`
    )
    .all(like, like, pageSize, (page - 1) * pageSize);
  return { total, rows };
}

function productValues(input) {
  const out = {
    sku: String(input.sku ?? '').trim(),
    name: String(input.name ?? '').trim(),
    cost: parseNum(input.cost),
    min_margin_percent: parseNum(input.min_margin_percent),
    min_profit: parseNum(input.min_profit),
  };
  if (!out.sku) throw new Error('SKU é obrigatório');
  if (out.cost === null || out.cost < 0) throw new Error(`Custo inválido para ${out.sku}`);
  if (!out.name) out.name = out.sku;
  return out;
}

export function saveProduct(db, input, id) {
  const v = productValues(input);
  if (id) {
    db.prepare("UPDATE products SET sku = ?, name = ?, cost = ?, min_margin_percent = ?, min_profit = ?, updated_at = datetime('now') WHERE id = ?").run(
      v.sku, v.name, v.cost, v.min_margin_percent, v.min_profit, id
    );
    return db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  }
  const r = db.prepare('INSERT INTO products(sku, name, cost, min_margin_percent, min_profit) VALUES (?, ?, ?, ?, ?)').run(v.sku, v.name, v.cost, v.min_margin_percent, v.min_profit);
  return db.prepare('SELECT * FROM products WHERE id = ?').get(r.lastInsertRowid);
}

/** Importa/atualiza produtos em massa (upsert por SKU). */
export function importProducts(db, csv) {
  const rows = parseCsv(csv);
  const errors = [];
  let created = 0;
  let updated = 0;
  const find = db.prepare('SELECT id FROM products WHERE sku = ?');
  const ins = db.prepare('INSERT INTO products(sku, name, cost, min_margin_percent, min_profit) VALUES (?, ?, ?, ?, ?)');
  const upd = db.prepare("UPDATE products SET name = ?, cost = ?, min_margin_percent = ?, min_profit = ?, updated_at = datetime('now') WHERE id = ?");
  tx(db, () => {
    rows.forEach((r, i) => {
      try {
        const v = productValues({
          sku: pickField(r, ['sku', 'codigo', 'code']),
          name: pickField(r, ['nome', 'name', 'produto', 'descricao']),
          cost: pickField(r, ['custo', 'cost', 'preco_de_custo', 'preco_custo']),
          min_margin_percent: pickField(r, ['margem_minima', 'min_margin', 'min_margin_percent', 'margem']),
          min_profit: pickField(r, ['lucro_minimo', 'min_profit', 'lucro']),
        });
        const ex = find.get(v.sku);
        if (ex) {
          upd.run(v.name, v.cost, v.min_margin_percent, v.min_profit, ex.id);
          updated++;
        } else {
          ins.run(v.sku, v.name, v.cost, v.min_margin_percent, v.min_profit);
          created++;
        }
      } catch (e) {
        errors.push(`Linha ${i + 2}: ${e.message}`);
      }
    });
  });
  return { created, updated, errors };
}

// ---------- Anúncios ----------

const LISTING_SELECT = `
  SELECT l.*, f.percent AS fee_percent, lc.cost, lc.min_profit, lc.min_margin_percent, lc.products,
         (SELECT COUNT(*) FROM promotion_items pi WHERE pi.listing_id = l.id AND pi.status IN ('started','pending','programmed')) AS in_promotions,
         (SELECT COUNT(*) FROM promotion_items pi WHERE pi.listing_id = l.id AND pi.status = 'candidate') AS candidate_promotions
  FROM listings l
  LEFT JOIN fee_rates f ON f.category_id = l.category_id AND f.listing_type_id = l.listing_type_id
  LEFT JOIN listing_costs lc ON lc.listing_id = l.id`;

function listingWhere({ search = '', linked = '', status = '', productId } = {}) {
  const conds = ["l.status <> 'closed'"];
  const args = [];
  if (search.trim()) {
    const terms = search.trim().split(/\s+/);
    for (const t of terms) {
      conds.push('(l.id LIKE ? OR l.title LIKE ? OR l.sku LIKE ? OR lc.products LIKE ?)');
      args.push(`%${t}%`, `%${t}%`, `%${t}%`, `%${t}%`);
    }
  }
  if (linked === 'yes') conds.push('lc.listing_id IS NOT NULL');
  if (linked === 'no') conds.push('lc.listing_id IS NULL');
  if (status) {
    conds.push('l.status = ?');
    args.push(status);
  }
  if (productId) {
    conds.push('l.id IN (SELECT listing_id FROM listing_products WHERE product_id = ?)');
    args.push(Number(productId));
  }
  return { sql: 'WHERE ' + conds.join(' AND '), args };
}

export function enrichListing(row, settings) {
  const ctx = buildContext(row, settings);
  const minPrice = minViablePrice(ctx);
  const current = ctx.linked ? profitAt(row.price, ctx) : null;
  return {
    ...row,
    fee_percent: ctx.feePercent,
    shipping_effective: ctx.shipping,
    min_profit_rule: ctx.minProfit,
    min_margin_rule: ctx.minMarginPercent,
    current_profit: current?.profit ?? null,
    current_margin: current?.margin ?? null,
    min_viable_price: minPrice,
    max_discount: minPrice ? Math.max(0, discountPercent(row.price, minPrice)) : null,
  };
}

export function listListings(db, query = {}) {
  const { page = 1, pageSize = 50 } = query;
  const w = listingWhere(query);
  const total = db.prepare(`SELECT COUNT(*) n FROM listings l LEFT JOIN listing_costs lc ON lc.listing_id = l.id ${w.sql}`).get(...w.args).n;
  const sort = { title: 'l.title', price: 'l.price DESC', sku: 'l.sku' }[query.sort] || 'l.title';
  const rows = db.prepare(`${LISTING_SELECT} ${w.sql} ORDER BY ${sort} LIMIT ? OFFSET ?`).all(...w.args, Number(pageSize), (page - 1) * pageSize);
  const settings = getSettings(db);
  return { total, rows: rows.map((r) => enrichListing(r, settings)) };
}

export function listingIdsByFilter(db, query) {
  const w = listingWhere(query);
  return db.prepare(`SELECT l.id FROM listings l LEFT JOIN listing_costs lc ON lc.listing_id = l.id ${w.sql}`).all(...w.args).map((r) => r.id);
}

export function getListing(db, id) {
  const row = db.prepare(`${LISTING_SELECT} WHERE l.id = ?`).get(id);
  if (!row) return null;
  const components = db
    .prepare('SELECT p.id, p.sku, p.name, p.cost, lp.quantity FROM listing_products lp JOIN products p ON p.id = lp.product_id WHERE lp.listing_id = ?')
    .all(id);
  return { ...enrichListing(row, getSettings(db)), components };
}

/**
 * Vincula um produto a vários anúncios de uma vez.
 * mode = 'replace' remove vínculos anteriores (anúncio simples); 'add' acrescenta ao kit.
 */
export function linkListings(db, { listingIds, productId, quantity = 1, mode = 'replace' }) {
  const product = db.prepare('SELECT id FROM products WHERE id = ?').get(productId);
  if (!product) throw new Error('Produto não encontrado');
  const qty = parseNum(quantity);
  if (!qty || qty <= 0) throw new Error('Quantidade inválida');
  const del = db.prepare('DELETE FROM listing_products WHERE listing_id = ?');
  const ins = db.prepare(
    'INSERT INTO listing_products(listing_id, product_id, quantity) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET quantity = excluded.quantity'
  );
  const exists = db.prepare('SELECT 1 FROM listings WHERE id = ?');
  let n = 0;
  tx(db, () => {
    for (const id of listingIds) {
      if (!exists.get(id)) continue;
      if (mode === 'replace') del.run(id);
      ins.run(id, productId, qty);
      n++;
    }
  });
  return { linked: n };
}

export function unlinkListings(db, listingIds) {
  const del = db.prepare('DELETE FROM listing_products WHERE listing_id = ?');
  tx(db, () => listingIds.forEach((id) => del.run(id)));
  return { unlinked: listingIds.length };
}

/**
 * Resolve o SKU do anúncio em produtos:
 *  "ABC"            → ABC x1
 *  "ABC-KIT3", "ABC_X3", "ABC*3" → ABC x3 (quando "ABC-KIT3" não existe como produto)
 *  "ABC+DEF"        → kit com ABC x1 e DEF x1
 *  "ABC,ABC"        → (variações com o mesmo SKU) ABC x1
 */
export function resolveSku(sku, findProduct) {
  if (!sku) return null;
  const variants = [...new Set(sku.split(',').map((s) => s.trim()).filter(Boolean))];
  if (variants.length !== 1) {
    const resolved = variants.map((v) => resolveSku(v, findProduct));
    const key = (r) => JSON.stringify(r);
    return resolved.every((r) => r && key(r) === key(resolved[0])) ? resolved[0] : null;
  }
  const s = variants[0];
  const direct = findProduct(s);
  if (direct) return [{ product_id: direct.id, quantity: 1 }];
  if (s.includes('+')) {
    const parts = s.split('+').map((x) => resolveSku(x.trim(), findProduct));
    if (parts.every((p) => p && p.length === 1)) {
      const merged = new Map();
      for (const [p] of parts) merged.set(p.product_id, (merged.get(p.product_id) || 0) + p.quantity);
      return [...merged].map(([product_id, quantity]) => ({ product_id, quantity }));
    }
    return null;
  }
  const m = s.match(/^(.+?)[\s_-]*(?:KIT|X|\*)\s*(\d+)$/i);
  if (m) {
    const base = findProduct(m[1]);
    if (base) return [{ product_id: base.id, quantity: Number(m[2]) }];
  }
  return null;
}

/** Vincula automaticamente anúncios a produtos pelo SKU. */
export function autoLink(db, { overwrite = false } = {}) {
  const find = db.prepare('SELECT id FROM products WHERE sku = ?');
  const findProduct = (s) => find.get(s);
  const rows = db
    .prepare(
      `SELECT l.id, l.sku, EXISTS(SELECT 1 FROM listing_products lp WHERE lp.listing_id = l.id) AS has_link
       FROM listings l WHERE l.status <> 'closed' AND l.sku IS NOT NULL`
    )
    .all();
  const del = db.prepare('DELETE FROM listing_products WHERE listing_id = ?');
  const ins = db.prepare('INSERT INTO listing_products(listing_id, product_id, quantity) VALUES (?, ?, ?)');
  let linked = 0;
  let notFound = 0;
  let skipped = 0;
  tx(db, () => {
    for (const r of rows) {
      if (r.has_link && !overwrite) {
        skipped++;
        continue;
      }
      const comps = resolveSku(r.sku, findProduct);
      if (!comps) {
        notFound++;
        continue;
      }
      del.run(r.id);
      for (const c of comps) ins.run(r.id, c.product_id, c.quantity);
      linked++;
    }
  });
  return { linked, not_found: notFound, skipped };
}

/** Importa vínculos via CSV: anuncio;sku;quantidade */
export function importLinks(db, csv) {
  const rows = parseCsv(csv);
  const errors = [];
  const findP = db.prepare('SELECT id FROM products WHERE sku = ?');
  const findL = db.prepare('SELECT id FROM listings WHERE id = ?');
  const byListing = new Map();
  rows.forEach((r, i) => {
    const lid = String(pickField(r, ['anuncio', 'listing', 'listing_id', 'mlb', 'id']) || '').trim().toUpperCase().replace('-', '');
    const sku = pickField(r, ['sku', 'produto', 'product']);
    const qty = parseNum(pickField(r, ['quantidade', 'qtd', 'quantity', 'qty']) ?? 1);
    const p = sku && findP.get(sku.trim());
    if (!findL.get(lid)) return errors.push(`Linha ${i + 2}: anúncio ${lid || '(vazio)'} não importado`);
    if (!p) return errors.push(`Linha ${i + 2}: produto ${sku || '(vazio)'} não cadastrado`);
    if (!qty || qty <= 0) return errors.push(`Linha ${i + 2}: quantidade inválida`);
    if (!byListing.has(lid)) byListing.set(lid, new Map());
    byListing.get(lid).set(p.id, qty);
  });
  const del = db.prepare('DELETE FROM listing_products WHERE listing_id = ?');
  const ins = db.prepare('INSERT INTO listing_products(listing_id, product_id, quantity) VALUES (?, ?, ?)');
  tx(db, () => {
    for (const [lid, comps] of byListing) {
      del.run(lid);
      for (const [pid, q] of comps) ins.run(lid, pid, q);
    }
  });
  return { linked: byListing.size, errors };
}

export function updateListingOverrides(db, id, { shipping_cost_override, fee_percent_override }) {
  const cur = db.prepare('SELECT * FROM listings WHERE id = ?').get(id);
  if (!cur) throw new Error('Anúncio não encontrado');
  db.prepare('UPDATE listings SET shipping_cost_override = ?, fee_percent_override = ? WHERE id = ?').run(
    shipping_cost_override === undefined ? cur.shipping_cost_override : parseNum(shipping_cost_override),
    fee_percent_override === undefined ? cur.fee_percent_override : parseNum(fee_percent_override),
    id
  );
  return getListing(db, id);
}
