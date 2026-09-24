import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config as defaultConfig } from './config.js';
import { openDb, getSettings, saveSettings, DEFAULT_SETTINGS } from './db.js';
import { MLClient } from './ml/client.js';
import { createMockML } from './ml/mock.js';
import { JobManager } from './services/jobs.js';
import { syncListings, syncPromotions, syncPromotionItems, syncShippingCosts } from './services/sync.js';
import * as catalog from './services/catalog.js';
import * as promos from './services/promotions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp({ config = defaultConfig, db = openDb(config.dbPath), mock } = {}) {
  if (config.mock && !mock) mock = createMockML();
  const ml = new MLClient({ db, config, transport: mock?.transport });
  const jobs = new JobManager(db);
  const ctx = { db, ml, concurrency: config.concurrency };
  const app = express();

  app.use(express.json({ limit: '20mb' }));
  app.use(express.text({ type: ['text/csv', 'text/plain'], limit: '20mb' }));

  if (config.basicAuth) {
    const expected = Buffer.from(`${config.basicAuth.user}:${config.basicAuth.password}`);
    app.use((req, res, next) => {
      const got = Buffer.from((req.headers.authorization || '').replace(/^Basic /, ''), 'base64');
      if (got.length === expected.length && crypto.timingSafeEqual(got, expected)) return next();
      res.set('WWW-Authenticate', 'Basic realm="Promo ML"').status(401).send('Autenticação necessária');
    });
  }

  app.use(express.static(path.join(__dirname, '..', 'public')));

  const intq = (v, d) => Math.max(1, Number.parseInt(v, 10) || d);

  // ---------- Autenticação Mercado Livre ----------
  const oauthStates = new Set();

  app.get('/auth/login', async (req, res, next) => {
    try {
      if (config.mock) {
        await ml.exchangeCode('mock');
        return res.redirect('/');
      }
      if (!config.ml.clientId || !config.ml.redirectUri) return res.status(400).send('Configure ML_CLIENT_ID, ML_CLIENT_SECRET e ML_REDIRECT_URI no .env');
      const state = crypto.randomBytes(12).toString('hex');
      oauthStates.add(state);
      res.redirect(ml.authUrl(state));
    } catch (e) {
      next(e);
    }
  });

  app.get('/auth/callback', async (req, res) => {
    try {
      if (req.query.state && !oauthStates.delete(String(req.query.state))) throw new Error('state inválido, tente conectar novamente');
      if (!req.query.code) throw new Error(req.query.error_description || 'Código de autorização ausente');
      await ml.exchangeCode(String(req.query.code));
      res.redirect('/');
    } catch (e) {
      res.status(400).send(`Falha ao conectar: ${e.message}. <a href="/">Voltar</a>`);
    }
  });

  const api = express.Router();

  api.post('/auth/code', async (req, res) => {
    const me = await ml.exchangeCode(String(req.body.code || '').trim());
    res.json({ ok: true, user: me });
  });

  api.post('/auth/logout', (req, res) => {
    db.prepare('DELETE FROM auth').run();
    res.json({ ok: true });
  });

  api.get('/status', (req, res) => {
    const auth = ml.getAuth();
    const count = (sql) => db.prepare(sql).get().n;
    const lastSync = (k) => {
      const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(`sync_${k}`);
      return r ? JSON.parse(r.value) : null;
    };
    res.json({
      connected: !!auth,
      user: auth ? { id: auth.user_id, nickname: auth.nickname } : null,
      mock: config.mock,
      configured: config.mock || !!(config.ml.clientId && config.ml.clientSecret && config.ml.redirectUri),
      auth_url: auth || config.mock || !config.ml.clientId ? null : ml.authUrl(),
      counts: {
        products: count('SELECT COUNT(*) n FROM products'),
        listings: count("SELECT COUNT(*) n FROM listings WHERE status <> 'closed'"),
        linked: count("SELECT COUNT(*) n FROM listings l WHERE status <> 'closed' AND EXISTS (SELECT 1 FROM listing_products lp WHERE lp.listing_id = l.id)"),
        promotions: count('SELECT COUNT(*) n FROM promotions'),
      },
      last_sync: { listings: lastSync('listings'), promotions: lastSync('promotions') },
      running: jobs.list(10).filter((j) => j.status === 'running'),
    });
  });

  // ---------- Configurações ----------
  api.get('/settings', (req, res) => res.json(getSettings(db)));
  api.put('/settings', (req, res) => {
    const patch = {};
    for (const [k, v] of Object.entries(req.body || {})) {
      const def = DEFAULT_SETTINGS[k];
      if (def === undefined) continue;
      if (typeof def === 'number') {
        const n = catalog.parseNum(v);
        if (n === null) return res.status(400).json({ error: `Valor inválido para ${k}` });
        patch[k] = n;
      } else if (typeof def === 'boolean') patch[k] = !!v;
      else if (k === 'fixed_fee_bands') {
        if (!Array.isArray(v)) return res.status(400).json({ error: 'Faixas inválidas' });
        patch[k] = v
          .map((b) => ({ up_to: catalog.parseNum(b.up_to), fee: catalog.parseNum(b.fee) }))
          .filter((b) => b.up_to !== null && b.fee !== null);
      } else if (k === 'sync_statuses') {
        patch[k] = (Array.isArray(v) ? v : [v]).filter((s) => ['active', 'paused', 'closed', 'under_review', 'inactive'].includes(s));
      }
    }
    res.json(saveSettings(db, patch));
  });

  // ---------- Produtos ----------
  api.get('/products', (req, res) => {
    res.json(catalog.listProducts(db, { search: String(req.query.search || ''), page: intq(req.query.page, 1), pageSize: Math.min(500, intq(req.query.pageSize, 50)) }));
  });
  api.get('/products/all', (req, res) => res.json(db.prepare('SELECT id, sku, name, cost FROM products ORDER BY sku').all()));
  api.post('/products', (req, res) => res.json(catalog.saveProduct(db, req.body)));
  api.put('/products/:id', (req, res) => res.json(catalog.saveProduct(db, req.body, Number(req.params.id))));
  api.delete('/products/:id', (req, res) => {
    db.prepare('DELETE FROM products WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  });
  api.post('/products/import', (req, res) => res.json(catalog.importProducts(db, typeof req.body === 'string' ? req.body : req.body.csv || '')));

  // ---------- Anúncios ----------
  const listingQuery = (q) => ({
    search: String(q.search || ''),
    linked: String(q.linked || ''),
    status: String(q.status || ''),
    productId: q.productId ? Number(q.productId) : undefined,
    sort: String(q.sort || ''),
  });
  api.get('/listings', (req, res) => {
    res.json(catalog.listListings(db, { ...listingQuery(req.query), page: intq(req.query.page, 1), pageSize: Math.min(500, intq(req.query.pageSize, 50)) }));
  });
  api.get('/listings/:id', (req, res) => {
    const l = catalog.getListing(db, req.params.id);
    if (!l) return res.status(404).json({ error: 'Anúncio não encontrado' });
    res.json(l);
  });
  api.put('/listings/:id', (req, res) => res.json(catalog.updateListingOverrides(db, req.params.id, req.body)));

  // Seleção pode ser por IDs ou por filtro ("todos os resultados da busca")
  const resolveSelection = (body) => (body.listing_ids?.length ? body.listing_ids : body.filter ? catalog.listingIdsByFilter(db, listingQuery(body.filter)) : []);
  api.post('/listings/link', (req, res) => {
    res.json(catalog.linkListings(db, { listingIds: resolveSelection(req.body), productId: Number(req.body.product_id), quantity: req.body.quantity ?? 1, mode: req.body.mode || 'replace' }));
  });
  api.post('/listings/unlink', (req, res) => res.json(catalog.unlinkListings(db, resolveSelection(req.body))));
  api.post('/listings/auto-link', (req, res) => res.json(catalog.autoLink(db, { overwrite: !!req.body?.overwrite })));
  api.post('/listings/import-links', (req, res) => res.json(catalog.importLinks(db, typeof req.body === 'string' ? req.body : req.body.csv || '')));

  // ---------- Sincronização ----------
  api.post('/sync/listings', (req, res) => {
    const job = jobs.start('sync_listings', 'Importar anúncios do Mercado Livre', (job) => syncListings({ ...ctx, job }));
    res.json(jobs.view(job));
  });
  api.post('/sync/shipping', (req, res) => {
    const job = jobs.start('sync_shipping', 'Atualizar custos de frete', (job) => syncShippingCosts({ ...ctx, job, force: true }));
    res.json(jobs.view(job));
  });
  api.post('/sync/promotions', (req, res) => {
    const job = jobs.start('sync_promotions', 'Importar campanhas e candidatos', (job) => syncPromotions({ ...ctx, job }));
    res.json(jobs.view(job));
  });
  api.post('/sync/promotions/:id', (req, res) => {
    const p = db.prepare('SELECT * FROM promotions WHERE id = ?').get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Campanha não encontrada' });
    const job = jobs.start(`sync_promo_${p.id}`, `Atualizar anúncios da campanha ${p.name || p.id}`, async (job) => {
      job.setTotal(1);
      const n = await syncPromotionItems({ db, ml, promotionId: p.id, promotionType: p.type, job });
      job.ok(`${n} anúncios`);
    });
    res.json(jobs.view(job));
  });

  // ---------- Campanhas ----------
  api.get('/promotions', (req, res) => res.json({ rows: promos.listPromotions(db), types: promos.PROMOTION_TYPES, strategies: promos.STRATEGIES }));

  const evalOpts = (q) => ({ strategy: String(q.strategy || 'percent'), percent: catalog.parseNum(q.percent) ?? getSettings(db).default_percent });

  api.get('/promotions/:id/evaluate', (req, res) => {
    const ev = promos.evaluatePromotion(db, req.params.id, evalOpts(req.query));
    if (!ev) return res.status(404).json({ error: 'Campanha não encontrada' });
    const filtered = promos.filterRows(ev.rows, { filter: String(req.query.filter || 'all'), search: String(req.query.search || '') });
    const sortKey = String(req.query.sort || '');
    const dir = req.query.dir === 'desc' ? -1 : 1;
    if (sortKey) filtered.sort((a, b) => ((a[sortKey] ?? -Infinity) > (b[sortKey] ?? -Infinity) ? dir : (a[sortKey] ?? -Infinity) < (b[sortKey] ?? -Infinity) ? -dir : 0));
    const page = intq(req.query.page, 1);
    const pageSize = Math.min(1000, intq(req.query.pageSize, 100));
    res.json({
      promo: ev.promo,
      summary: ev.summary,
      total: filtered.length,
      // IDs de todos os resultados do filtro, para "selecionar todos"
      filtered_ids: req.query.ids === '1' ? filtered.map((r) => r.listing_id) : undefined,
      rows: filtered.slice((page - 1) * pageSize, page * pageSize),
    });
  });

  api.post('/promotions/apply', (req, res) => {
    const ids = (req.body.promotion_ids || []).map(String);
    if (!ids.length) return res.status(400).json({ error: 'Informe ao menos uma campanha' });
    const opts = evalOpts(req.body);
    const title = ids.length === 1 ? `Incluir anúncios na campanha ${db.prepare('SELECT name FROM promotions WHERE id = ?').get(ids[0])?.name || ids[0]}` : `Incluir anúncios em ${ids.length} campanhas`;
    const job = jobs.start(
      'apply',
      title,
      (job) =>
        promos.applyToPromotions({
          ...ctx,
          job,
          promotionIds: ids,
          ...opts,
          listingIds: req.body.listing_ids,
          onlyViable: req.body.only_viable !== false,
        }),
      { exclusive: false }
    );
    res.json(jobs.view(job));
  });

  api.post('/promotions/:id/remove', (req, res) => {
    const job = jobs.start('remove', 'Remover anúncios da campanha', (job) => promos.removeFromPromotion({ ...ctx, job, promotionId: req.params.id, listingIds: req.body.listing_ids }), { exclusive: false });
    res.json(jobs.view(job));
  });

  // ---------- Modo simulado ----------
  if (mock) {
    api.post('/mock/seed-products', (req, res) => {
      const csv = 'sku;nome;custo\n' + Object.entries(mock.productCosts).map(([sku, c]) => `${sku};Produto de exemplo ${sku};${c}`).join('\n');
      res.json(catalog.importProducts(db, csv));
    });
  }

  // ---------- Tarefas ----------
  api.get('/jobs', (req, res) => res.json(jobs.list()));
  api.get('/jobs/:id', (req, res) => {
    const j = jobs.get(req.params.id);
    if (!j) return res.status(404).json({ error: 'Tarefa não encontrada' });
    res.json(j);
  });

  app.use('/api', api);

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status && err.status < 500 ? (err.status === 401 ? 401 : 400) : err.message?.includes('UNIQUE') ? 409 : 400;
    const msg = err.message?.includes('UNIQUE constraint failed: products.sku') ? 'Já existe um produto com este SKU' : err.message;
    res.status(status).json({ error: msg });
  });

  return { app, db, ml, jobs, mock };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { app } = createApp();
  app.listen(defaultConfig.port, () => {
    console.log(`Promo ML rodando em http://localhost:${defaultConfig.port}${defaultConfig.mock ? ' (modo simulado)' : ''}`);
  });
}
