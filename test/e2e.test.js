import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { openDb } from '../src/db.js';
import { createMockML } from '../src/ml/mock.js';

let server, base, mock;
const cfg = { port: 0, mock: true, concurrency: 8, basicAuth: null, ml: { apiBase: 'https://api.mercadolibre.com', authHost: 'https://auth.mercadolivre.com.br', siteId: 'MLB' } };

before(async () => {
  mock = createMockML({ listings: 250, products: 40 });
  const { app } = createApp({ config: cfg, db: openDb(':memory:'), mock });
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const api = async (method, path, body) => {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': typeof body === 'string' ? 'text/csv' : 'application/json' }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${data.error}`);
  return data;
};
const waitJob = async (job) => {
  for (;;) {
    const j = await api('GET', `/api/jobs/${job.id}`);
    if (j.status !== 'running') return j;
    await new Promise((r) => setTimeout(r, 20));
  }
};

test('fluxo completo: conectar, importar, vincular, avaliar e incluir em campanha', async () => {
  // Conectar (modo simulado)
  await fetch(base + '/auth/login', { redirect: 'manual' });
  let st = await api('GET', '/api/status');
  assert.equal(st.connected, true);
  assert.equal(st.user.nickname, 'LOJA_DEMO');

  // Importar anúncios
  let job = await waitJob(await api('POST', '/api/sync/listings'));
  assert.equal(job.status, 'done', JSON.stringify(job.log?.slice(0, 3)));
  st = await api('GET', '/api/status');
  const expected = [...mock.items.values()].filter((i) => ['active', 'paused'].includes(i.status)).length;
  assert.equal(st.counts.listings, expected);

  // Tarifas e frete importados
  const l = (await api('GET', '/api/listings?pageSize=500')).rows;
  assert.ok(l.every((x) => x.fee_percent >= 12));
  assert.ok(l.filter((x) => x.free_shipping).every((x) => x.shipping_cost > 0));

  // Cadastrar produtos por CSV e vincular por SKU (inclui kits "-KIT2")
  const csv = 'sku;nome;custo\n' + Object.entries(mock.productCosts).map(([s, c]) => `${s};Produto ${s};${String(c).replace('.', ',')}`).join('\n');
  const imp = await api('POST', '/api/products/import', csv);
  assert.equal(imp.created, 40);
  assert.deepEqual(imp.errors, []);
  const link = await api('POST', '/api/listings/auto-link', {});
  assert.equal(link.linked, expected);
  assert.equal(link.not_found, 0);

  // Custo do kit = 2x o custo do produto
  const kit = l.find((x) => x.sku.endsWith('-KIT2'));
  const kitDetail = await api('GET', `/api/listings/${kit.id}`);
  const baseSku = kit.sku.replace('-KIT2', '');
  assert.equal(kitDetail.components[0].quantity, 2);
  assert.ok(Math.abs(kitDetail.cost - 2 * mock.productCosts[baseSku]) < 0.01);

  // Importar campanhas
  job = await waitJob(await api('POST', '/api/sync/promotions'));
  assert.equal(job.status, 'done');
  const { rows: promos } = await api('GET', '/api/promotions');
  assert.equal(promos.length, mock.promotions.length);

  // Avaliar campanha DEAL com percentual geral de 15%
  const deal = promos.find((p) => p.type === 'DEAL');
  const ev = await api('GET', `/api/promotions/${deal.id}/evaluate?strategy=percent&percent=15&pageSize=1000`);
  assert.equal(ev.total, deal.items);
  assert.ok(ev.summary.viable > 0 && ev.summary.not_viable > 0, JSON.stringify(ev.summary));
  for (const r of ev.rows.filter((x) => x.viable)) {
    assert.ok(r.profit >= 0 && r.margin >= 10, `viável com margem ${r.margin}`);
    assert.ok(r.target_price <= r.max_allowed && r.target_price >= r.min_allowed);
  }

  // Maior desconto viável nunca fica abaixo do preço mínimo viável
  const evMax = await api('GET', `/api/promotions/${deal.id}/evaluate?strategy=max_viable&pageSize=1000`);
  for (const r of evMax.rows.filter((x) => x.viable)) assert.ok(r.target_price >= r.min_viable_price);
  assert.ok(evMax.summary.viable >= ev.summary.viable);

  // Incluir todos os viáveis
  job = await waitJob(await api('POST', '/api/promotions/apply', { promotion_ids: [deal.id], strategy: 'percent', percent: 15 }));
  assert.equal(job.status, 'done', JSON.stringify(job.log.filter((x) => !x.ok).slice(0, 3)));
  assert.equal(job.done, ev.summary.viable);
  const inMock = [...mock.promoItems.get(deal.id).values()].filter((x) => x.status !== 'candidate');
  assert.equal(inMock.length, ev.summary.viable);
  for (const it of inMock) assert.ok(Math.abs(it.price - Math.floor(it.original_price * 0.85 * 100) / 100) < 0.011 || it.price === it.max_discounted_price);

  const after = await api('GET', `/api/promotions/${deal.id}/evaluate?percent=15`);
  assert.equal(after.summary.participating, ev.summary.viable);
  assert.equal(after.summary.viable, 0);

  // Várias campanhas de uma vez (co-participada + automatizada com offer_id)
  const others = promos.filter((p) => ['MARKETPLACE_CAMPAIGN', 'SMART'].includes(p.type)).map((p) => p.id);
  job = await waitJob(await api('POST', '/api/promotions/apply', { promotion_ids: others, strategy: 'percent', percent: 10 }));
  assert.equal(job.status, 'done', JSON.stringify(job.log.filter((x) => !x.ok).slice(0, 3)));
  assert.ok(job.done > 0);

  // Remover selecionados
  const some = after.rows.filter((r) => r.participating).slice(0, 3).map((r) => r.listing_id);
  job = await waitJob(await api('POST', `/api/promotions/${deal.id}/remove`, { listing_ids: some }));
  assert.equal(job.done, 3);
  assert.equal(job.failed, 0);
  for (const id of some) assert.equal(mock.promoItems.get(deal.id).get(id).status, 'candidate');
});

test('vínculo em massa por filtro e anúncio sem vínculo fica inviável', async () => {
  const { rows } = await api('GET', '/api/products?pageSize=1');
  const filter = { search: 'variação 1' };
  const sel = await api('GET', `/api/listings?search=${encodeURIComponent(filter.search)}&pageSize=500`);
  await api('POST', '/api/listings/unlink', { filter });
  const un = await api('GET', `/api/listings?search=${encodeURIComponent(filter.search)}&linked=no&pageSize=500`);
  assert.equal(un.total, sel.total);
  const r = await api('POST', '/api/listings/link', { filter, product_id: rows[0].id, quantity: 3 });
  assert.equal(r.linked, sel.total);
  const d = await api('GET', `/api/listings/${sel.rows[0].id}`);
  assert.equal(d.components.length, 1);
  assert.equal(d.components[0].quantity, 3);
});
