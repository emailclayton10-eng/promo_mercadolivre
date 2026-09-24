import { now } from '../db.js';

export class MLError extends Error {
  constructor(status, data, method, path) {
    const detail = data?.message || data?.error || (typeof data === 'string' ? data : JSON.stringify(data));
    super(`ML ${method} ${path} → ${status}: ${detail}`);
    this.status = status;
    this.data = data;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Transporte HTTP real (fetch). */
export async function fetchTransport({ method, url, headers, body }) {
  const init = { method, headers: { Accept: 'application/json', ...headers } };
  if (body instanceof URLSearchParams) {
    init.body = body;
    init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let data = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {}
  return { status: res.status, data, retryAfter: Number(res.headers.get('retry-after')) || 0 };
}

export class MLClient {
  constructor({ db, config, transport = fetchTransport }) {
    this.db = db;
    this.cfg = config.ml;
    this.transport = transport;
    this.refreshing = null;
  }

  getAuth() {
    return this.db.prepare('SELECT * FROM auth WHERE id = 1').get() || null;
  }

  authUrl(state = '') {
    const u = new URL('/authorization', this.cfg.authHost);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', this.cfg.clientId);
    u.searchParams.set('redirect_uri', this.cfg.redirectUri);
    if (state) u.searchParams.set('state', state);
    return u.toString();
  }

  saveTokens(tok) {
    const prev = this.getAuth();
    const userId = tok.user_id ?? prev?.user_id;
    this.db
      .prepare(
        `INSERT INTO auth(id, user_id, nickname, access_token, refresh_token, expires_at) VALUES (1, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET user_id = excluded.user_id, access_token = excluded.access_token,
           refresh_token = excluded.refresh_token, expires_at = excluded.expires_at`
      )
      .run(userId, prev?.nickname ?? null, tok.access_token, tok.refresh_token ?? prev?.refresh_token ?? null, Date.now() + (tok.expires_in || 21600) * 1000);
  }

  async exchangeCode(code) {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      code,
      redirect_uri: this.cfg.redirectUri,
    });
    const tok = await this.raw('POST', '/oauth/token', { body, auth: false });
    this.saveTokens(tok);
    const me = await this.get('/users/me');
    this.db.prepare('UPDATE auth SET nickname = ?, user_id = ? WHERE id = 1').run(me.nickname, me.id);
    return me;
  }

  async refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const a = this.getAuth();
      if (!a?.refresh_token) throw new MLError(401, { message: 'Conta não conectada ao Mercado Livre' }, 'POST', '/oauth/token');
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        refresh_token: a.refresh_token,
      });
      const tok = await this.raw('POST', '/oauth/token', { body, auth: false });
      this.saveTokens(tok);
    })().finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  async token() {
    const a = this.getAuth();
    if (!a) throw new MLError(401, { message: 'Conta não conectada ao Mercado Livre' }, 'GET', '');
    if (a.expires_at - Date.now() < 5 * 60 * 1000) {
      await this.refresh();
      return this.getAuth().access_token;
    }
    return a.access_token;
  }

  userId() {
    const a = this.getAuth();
    if (!a) throw new MLError(401, { message: 'Conta não conectada ao Mercado Livre' }, 'GET', '');
    return a.user_id;
  }

  async raw(method, path, { query, body, auth = true } = {}) {
    const url = new URL(path, this.cfg.apiBase);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const headers = auth ? { Authorization: `Bearer ${await this.token()}` } : {};
      let res;
      try {
        res = await this.transport({ method, url: url.toString(), headers, body });
      } catch (e) {
        if (attempt < 4) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        throw e;
      }
      if (res.status === 401 && auth && !refreshed) {
        refreshed = true;
        await this.refresh();
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 5) {
        const wait = res.retryAfter ? res.retryAfter * 1000 : 500 * 2 ** attempt + Math.random() * 250;
        await sleep(wait);
        continue;
      }
      if (res.status >= 400) throw new MLError(res.status, res.data, method, url.pathname);
      return res.data;
    }
  }

  get(path, query) {
    return this.raw('GET', path, { query });
  }
  post(path, body, query) {
    return this.raw('POST', path, { body, query });
  }
  delete(path, query) {
    return this.raw('DELETE', path, { query });
  }

  // ---------- Endpoints usados pela aplicação ----------

  /** IDs de todos os anúncios do vendedor (search_type=scan permite passar de 1000 resultados). */
  async *scanItemIds(status) {
    const uid = this.userId();
    let scrollId;
    for (;;) {
      const r = await this.get(`/users/${uid}/items/search`, { search_type: 'scan', limit: 100, status, scroll_id: scrollId });
      if (!r.results?.length) return;
      yield { ids: r.results, total: r.paging?.total };
      scrollId = r.scroll_id;
      if (!scrollId) return;
    }
  }

  /** Multiget de até 20 anúncios. */
  async getItems(ids) {
    const attributes = 'id,title,price,original_price,status,listing_type_id,category_id,thumbnail,permalink,available_quantity,seller_custom_field,attributes,variations,shipping';
    const r = await this.get('/items', { ids: ids.join(','), attributes });
    return r.filter((x) => x.code === 200).map((x) => x.body);
  }

  async listingFeePercent(categoryId, listingTypeId, refPrice = 200) {
    const r = await this.get(`/sites/${this.cfg.siteId}/listing_prices`, { price: refPrice, listing_type_id: listingTypeId, category_id: categoryId });
    const obj = Array.isArray(r) ? r.find((x) => x.listing_type_id === listingTypeId) || r[0] : r;
    const d = obj?.sale_fee_details;
    if (d?.percentage_fee !== undefined) return Number(d.percentage_fee);
    if (obj?.sale_fee_amount !== undefined) return (Number(obj.sale_fee_amount) / refPrice) * 100;
    return null;
  }

  async freeShippingCost(itemId) {
    const r = await this.get(`/users/${this.userId()}/shipping_options/free`, { item_id: itemId });
    return r?.coverage?.all_country?.list_cost ?? null;
  }

  async listPromotions() {
    const out = [];
    for (let offset = 0; ; offset += 50) {
      const r = await this.get(`/seller-promotions/users/${this.userId()}`, { app_version: 'v2', limit: 50, offset });
      out.push(...(r.results || []));
      if (!r.results?.length || out.length >= (r.paging?.total ?? 0) || r.results.length < 50) return out;
    }
  }

  async *promotionItems(promotionId, promotionType) {
    let searchAfter;
    for (;;) {
      const r = await this.get(`/seller-promotions/promotions/${promotionId}/items`, {
        promotion_type: promotionType,
        app_version: 'v2',
        limit: 50,
        search_after: searchAfter,
      });
      if (!r.results?.length) return;
      yield r.results;
      searchAfter = r.paging?.searchAfter ?? r.paging?.search_after;
      if (!searchAfter) return;
    }
  }

  addItemToPromotion(itemId, payload) {
    return this.post(`/seller-promotions/items/${itemId}`, payload, { app_version: 'v2' });
  }

  removeItemFromPromotion(itemId, { promotion_type, promotion_id, offer_id }) {
    return this.delete(`/seller-promotions/items/${itemId}`, { promotion_type, promotion_id, offer_id, app_version: 'v2' });
  }

  markSynced(key) {
    this.db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(`sync_${key}`, JSON.stringify(now()));
  }
}
