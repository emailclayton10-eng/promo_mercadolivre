// API do Mercado Livre simulada, usada com ML_MOCK=1 e nos testes.
// Reproduz o formato das respostas dos endpoints que a aplicação consome.

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const r2 = (v) => Math.round(v * 100) / 100;

export function createMockML({ listings = 400, products = 60, seed = 42 } = {}) {
  const rand = rng(seed);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const USER = { id: 123456789, nickname: 'LOJA_DEMO' };
  const categories = { MLB1051: 12, MLB1648: 14, MLB1574: 16.5 };

  const productCosts = {};
  for (let i = 1; i <= products; i++) productCosts[`SKU-${String(i).padStart(3, '0')}`] = r2(8 + rand() * 120);

  const items = new Map();
  for (let i = 1; i <= listings; i++) {
    const sku = `SKU-${String(1 + Math.floor(rand() * products)).padStart(3, '0')}`;
    const kit = rand() < 0.12 ? 2 : 1;
    const cost = productCosts[sku] * kit;
    const price = r2(cost * (1.6 + rand() * 1.2));
    const id = `MLB${3000000000 + i}`;
    const listingType = rand() < 0.6 ? 'gold_special' : 'gold_pro';
    items.set(id, {
      id,
      title: `${kit > 1 ? `Kit ${kit}x ` : ''}Produto ${sku} - variação ${i}`,
      price,
      original_price: null,
      status: rand() < 0.9 ? 'active' : 'paused',
      listing_type_id: listingType,
      category_id: pick(Object.keys(categories)),
      thumbnail: `https://http2.mlstatic.com/D_NQ_NP_${i}-O.webp`,
      permalink: `https://produto.mercadolivre.com.br/${id.replace('MLB', 'MLB-')}`,
      available_quantity: Math.floor(rand() * 80),
      seller_custom_field: null,
      attributes: [{ id: 'SELLER_SKU', value_name: kit > 1 ? `${sku}-KIT${kit}` : sku }],
      shipping: { free_shipping: price >= 79, logistic_type: pick(['cross_docking', 'fulfillment', 'drop_off']) },
      _shipCost: r2(18 + rand() * 20),
    });
  }

  const now = Date.now();
  const iso = (d) => new Date(now + d * 86400000).toISOString();
  const promotions = [
    { id: 'P-MLB1001', type: 'DEAL', name: 'Semana do Consumidor', status: 'started', start_date: iso(-1), finish_date: iso(10), deadline_date: iso(8) },
    { id: 'P-MLB1002', type: 'MARKETPLACE_CAMPAIGN', name: 'Campanha co-participada 15%', status: 'pending', start_date: iso(3), finish_date: iso(20), deadline_date: iso(2), benefits: { type: 'REBATE', meli_percent: 5, seller_percent: 10 } },
    { id: 'P-MLB1003', type: 'SELLER_CAMPAIGN', name: 'Minha campanha de outubro', status: 'started', start_date: iso(-2), finish_date: iso(28), sub_type: 'FLEXIBLE_PERCENTAGE' },
    { id: 'P-MLB1004', type: 'LIGHTNING', name: 'Oferta relâmpago', status: 'pending', start_date: iso(5), finish_date: iso(5.25), deadline_date: iso(4) },
    { id: 'P-MLB1005', type: 'SMART', name: 'Campanha automatizada', status: 'started', start_date: iso(-3), finish_date: iso(15), benefits: { type: 'REBATE', meli_percent: 6, seller_percent: 12 } },
    { id: 'P-MLB1006', type: 'DOD', name: 'Oferta do dia', status: 'pending', start_date: iso(7), finish_date: iso(8), deadline_date: iso(6) },
  ];

  // Candidatos por promoção
  const promoItems = new Map();
  for (const p of promotions) {
    const m = new Map();
    for (const it of items.values()) {
      if (it.status !== 'active' || rand() > 0.55) continue;
      const orig = it.price;
      const base = { id: it.id, status: 'candidate', price: orig, original_price: orig };
      if (['DEAL', 'SELLER_CAMPAIGN', 'DOD', 'LIGHTNING'].includes(p.type)) {
        const minDisc = p.type === 'DEAL' ? 0.05 : p.type === 'DOD' ? 0.15 : 0.05;
        base.max_discounted_price = r2(orig * (1 - minDisc));
        base.min_discounted_price = r2(orig * 0.4);
        base.suggested_discounted_price = r2(orig * (1 - minDisc - 0.1));
        if (p.type === 'LIGHTNING') base.stock = { min: 1, max: Math.max(1, it.available_quantity) };
      } else {
        const seller = p.benefits.seller_percent;
        const meli = p.benefits.meli_percent;
        base.price = r2(orig * (1 - (seller + meli) / 100));
        base.meli_percentage = meli;
        base.seller_percentage = seller;
        if (p.type === 'SMART') base.offer_id = `OFFER-${p.id}-${it.id}`;
      }
      m.set(it.id, base);
    }
    promoItems.set(p.id, m);
  }

  const calls = { count: 0 };

  function reply(status, data) {
    return { status, data, retryAfter: 0 };
  }

  function handle(method, url, body) {
    calls.count++;
    const u = new URL(url);
    const q = Object.fromEntries(u.searchParams);
    const p = u.pathname;
    let m;

    if (method === 'POST' && p === '/oauth/token') {
      return reply(200, { access_token: `APP_USR-mock-${Date.now()}`, token_type: 'bearer', expires_in: 21600, user_id: USER.id, refresh_token: 'TG-mock-refresh' });
    }
    if (method === 'GET' && p === '/users/me') return reply(200, USER);

    if (method === 'GET' && (m = p.match(/^\/users\/(\d+)\/items\/search$/))) {
      const all = [...items.values()].filter((i) => !q.status || i.status === q.status).map((i) => i.id);
      const start = q.scroll_id ? Number(q.scroll_id) : 0;
      const limit = Number(q.limit) || 50;
      const results = all.slice(start, start + limit);
      return reply(200, { results, scroll_id: results.length ? String(start + limit) : null, paging: { total: all.length } });
    }

    if (method === 'GET' && p === '/items') {
      const ids = (q.ids || '').split(',').filter(Boolean);
      if (ids.length > 20) return reply(400, { message: 'too many ids' });
      return reply(
        200,
        ids.map((id) => {
          const it = items.get(id);
          if (!it) return { code: 404, body: { message: 'not found' } };
          const { _shipCost, ...pub } = it;
          return { code: 200, body: structuredClone(pub) };
        })
      );
    }

    if (method === 'GET' && (m = p.match(/^\/sites\/(\w+)\/listing_prices$/))) {
      const pct = categories[q.category_id] ?? 13;
      const extra = q.listing_type_id === 'gold_pro' ? 5 : 0;
      const price = Number(q.price);
      return reply(200, { listing_type_id: q.listing_type_id, sale_fee_amount: r2((price * (pct + extra)) / 100), sale_fee_details: { percentage_fee: pct + extra, fixed_fee: 0 } });
    }

    if (method === 'GET' && (m = p.match(/^\/users\/(\d+)\/shipping_options\/free$/))) {
      const it = items.get(q.item_id);
      if (!it) return reply(404, { message: 'item not found' });
      return reply(200, { coverage: { all_country: { list_cost: it._shipCost, currency_id: 'BRL' } } });
    }

    if (method === 'GET' && (m = p.match(/^\/seller-promotions\/users\/(\d+)$/))) {
      const offset = Number(q.offset) || 0;
      const limit = Number(q.limit) || 50;
      return reply(200, { results: structuredClone(promotions.slice(offset, offset + limit)), paging: { offset, limit, total: promotions.length } });
    }

    if (method === 'GET' && (m = p.match(/^\/seller-promotions\/promotions\/([^/]+)\/items$/))) {
      const pm = promoItems.get(m[1]);
      if (!pm) return reply(404, { message: 'promotion not found' });
      const all = [...pm.values()];
      const start = q.search_after ? Number(q.search_after) : 0;
      const limit = Number(q.limit) || 50;
      const results = all.slice(start, start + limit);
      const next = start + limit < all.length ? String(start + limit) : null;
      return reply(200, { results: structuredClone(results), paging: { limit, total: all.length, searchAfter: next } });
    }

    if (method === 'POST' && (m = p.match(/^\/seller-promotions\/items\/([^/]+)$/))) {
      const pm = promoItems.get(body?.promotion_id);
      const it = pm?.get(m[1]);
      if (!it) return reply(404, { message: 'item is not candidate for this promotion' });
      if (it.status !== 'candidate') return reply(400, { message: 'item already in promotion' });
      if (body.deal_price !== undefined) {
        if (body.deal_price > it.max_discounted_price || body.deal_price < it.min_discounted_price) {
          return reply(400, { message: `deal_price out of range [${it.min_discounted_price}, ${it.max_discounted_price}]` });
        }
        it.price = body.deal_price;
      }
      if (it.offer_id && body.offer_id !== it.offer_id) return reply(400, { message: 'invalid offer_id' });
      const promo = promotions.find((x) => x.id === body.promotion_id);
      it.status = promo.status === 'started' ? 'started' : 'pending';
      return reply(201, { price: it.price, original_price: it.original_price, status: it.status });
    }

    if (method === 'DELETE' && (m = p.match(/^\/seller-promotions\/items\/([^/]+)$/))) {
      const pm = promoItems.get(q.promotion_id);
      const it = pm?.get(m[1]);
      if (!it || it.status === 'candidate') return reply(404, { message: 'item not in promotion' });
      it.status = 'candidate';
      it.price = it.original_price;
      return reply(200, { status: 'ok' });
    }

    return reply(404, { message: `mock: rota não implementada ${method} ${p}` });
  }

  return {
    user: USER,
    productCosts,
    items,
    promotions,
    promoItems,
    calls,
    transport: async ({ method, url, body }) => {
      await new Promise((r) => setTimeout(r, 1));
      return handle(method, url, body);
    },
  };
}
