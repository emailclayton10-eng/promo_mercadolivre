import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  user_id       INTEGER NOT NULL,
  nickname      TEXT,
  access_token  TEXT NOT NULL,
  refresh_token TEXT,
  expires_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  sku                TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name               TEXT NOT NULL,
  cost               REAL NOT NULL DEFAULT 0,
  min_margin_percent REAL,
  min_profit         REAL,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS listings (
  id                     TEXT PRIMARY KEY,
  title                  TEXT NOT NULL,
  price                  REAL NOT NULL,
  original_price         REAL,
  status                 TEXT,
  listing_type_id        TEXT,
  category_id            TEXT,
  sku                    TEXT,
  thumbnail              TEXT,
  permalink              TEXT,
  available_quantity     INTEGER,
  free_shipping          INTEGER NOT NULL DEFAULT 0,
  logistic_type          TEXT,
  shipping_cost          REAL,
  shipping_updated_at    TEXT,
  shipping_cost_override REAL,
  fee_percent_override   REAL,
  synced_at              TEXT
);
CREATE INDEX IF NOT EXISTS idx_listings_sku ON listings(sku);

CREATE TABLE IF NOT EXISTS listing_products (
  listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  quantity   REAL NOT NULL DEFAULT 1,
  PRIMARY KEY (listing_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_lp_product ON listing_products(product_id);

CREATE TABLE IF NOT EXISTS fee_rates (
  category_id     TEXT NOT NULL,
  listing_type_id TEXT NOT NULL,
  percent         REAL NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (category_id, listing_type_id)
);

CREATE TABLE IF NOT EXISTS promotions (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL,
  name            TEXT,
  status          TEXT,
  start_date      TEXT,
  finish_date     TEXT,
  deadline_date   TEXT,
  benefits        TEXT,
  raw             TEXT,
  synced_at       TEXT,
  items_synced_at TEXT
);

CREATE TABLE IF NOT EXISTS promotion_items (
  promotion_id               TEXT NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
  listing_id                 TEXT NOT NULL,
  status                     TEXT,
  price                      REAL,
  original_price             REAL,
  min_discounted_price       REAL,
  max_discounted_price       REAL,
  suggested_discounted_price REAL,
  meli_percentage            REAL,
  seller_percentage          REAL,
  offer_id                   TEXT,
  raw                        TEXT,
  updated_at                 TEXT,
  PRIMARY KEY (promotion_id, listing_id)
);
CREATE INDEX IF NOT EXISTS idx_pi_listing ON promotion_items(listing_id);

CREATE TABLE IF NOT EXISTS jobs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT NOT NULL,
  title       TEXT NOT NULL,
  status      TEXT NOT NULL,
  total       INTEGER NOT NULL DEFAULT 0,
  done        INTEGER NOT NULL DEFAULT 0,
  failed      INTEGER NOT NULL DEFAULT 0,
  message     TEXT,
  log         TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);

-- Custo e regras de lucro agregados por anúncio (um anúncio pode ser kit de vários produtos)
DROP VIEW IF EXISTS listing_costs;
CREATE VIEW listing_costs AS
SELECT lp.listing_id,
       SUM(p.cost * lp.quantity)                                                  AS cost,
       SUM(CASE WHEN p.min_profit IS NOT NULL THEN p.min_profit * lp.quantity END) AS min_profit,
       MAX(p.min_margin_percent)                                                  AS min_margin_percent,
       GROUP_CONCAT(p.sku || CASE WHEN lp.quantity = 1 THEN '' WHEN lp.quantity = CAST(lp.quantity AS INTEGER) THEN ' x' || CAST(lp.quantity AS INTEGER) ELSE ' x' || lp.quantity END, ', ') AS products
FROM listing_products lp
JOIN products p ON p.id = lp.product_id
GROUP BY lp.listing_id;
`;

export const DEFAULT_SETTINGS = {
  tax_percent: 0,                 // impostos sobre a venda (%)
  default_min_margin_percent: 10, // margem mínima padrão (% sobre o preço de venda)
  default_min_profit: 0,          // lucro mínimo padrão (R$ por anúncio)
  default_fee_percent: 14,        // comissão usada quando a tarifa da categoria ainda não foi importada
  default_shipping_cost: 0,       // frete padrão quando o custo real não é conhecido
  free_shipping_threshold: 79,    // abaixo deste preço o vendedor não paga o frete grátis (regra MLB)
  fixed_fee_bands: [              // custo fixo por venda em faixas de preço (confira os valores vigentes)
    { up_to: 29, fee: 6.25 },
    { up_to: 50, fee: 6.5 },
    { up_to: 79, fee: 6.75 },
  ],
  fetch_shipping_costs: true,     // consulta o custo do frete grátis de cada anúncio na sincronização
  sync_statuses: ['active', 'paused'],
  default_percent: 10,            // percentual geral padrão na tela de campanhas
};

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  return db;
}

export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function getSettings(db) {
  const out = structuredClone(DEFAULT_SETTINGS);
  for (const row of db.prepare('SELECT key, value FROM settings').all()) {
    if (row.key in out) out[row.key] = JSON.parse(row.value);
  }
  return out;
}

export function saveSettings(db, patch) {
  const stmt = db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  tx(db, () => {
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in DEFAULT_SETTINGS)) continue;
      stmt.run(k, JSON.stringify(v));
    }
  });
  return getSettings(db);
}

export const now = () => new Date().toISOString();
