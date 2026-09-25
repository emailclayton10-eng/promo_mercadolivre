// ---------- Utilidades ----------
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const money = (v) => (v === null || v === undefined ? '—' : brl.format(v));
const pct = (v) => (v === null || v === undefined ? '—' : `${Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`);
const date = (v) => (v ? new Date(v).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
const signed = (v, fmt = money) => (v === null || v === undefined ? '—' : `<span class="${v < 0 ? 'neg' : 'pos'}">${fmt(v)}</span>`);
const debounce = (fn, ms = 250) => {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
};

async function api(method, path, body) {
  const isText = typeof body === 'string';
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': isText ? 'text/csv' : 'application/json' },
    body: body === undefined ? undefined : isText ? body : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
  return data;
}
const qs = (obj) => new URLSearchParams(Object.entries(obj).filter(([, v]) => v !== '' && v !== undefined && v !== null)).toString();

function toast(msg, error = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast${error ? ' error' : ''}`;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), error ? 6000 : 3000);
}

async function guard(fn) {
  try {
    return await fn();
  } catch (e) {
    toast(e.message, true);
  }
}

/** Abre um modal; resolve com os dados do formulário ou null se cancelado. */
function modal(html, { onOpen } = {}) {
  const dlg = $('#modal');
  const form = $('#modal-body');
  form.innerHTML = html;
  return new Promise((resolve) => {
    const close = () => {
      dlg.removeEventListener('close', close);
      const ok = dlg.returnValue === 'ok';
      resolve(ok ? Object.fromEntries(new FormData(form)) : null);
    };
    dlg.addEventListener('close', close);
    dlg.returnValue = '';
    dlg.showModal();
    onOpen?.(form);
  });
}
const confirmModal = async (title, body, okLabel = 'Confirmar') =>
  !!(await modal(`<h2>${title}</h2><div>${body}</div><div class="actions"><button value="cancel">Cancelar</button><button value="ok" class="primary">${okLabel}</button></div>`));

function pager(total, page, pageSize, onPage) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const el = document.createElement('div');
  el.className = 'pager';
  el.innerHTML = `<span>${total.toLocaleString('pt-BR')} registros</span>
    <span class="inline"><button class="link" data-p="${page - 1}" ${page <= 1 ? 'disabled' : ''}>‹ Anterior</button>
    Página ${page} de ${pages}
    <button class="link" data-p="${page + 1}" ${page >= pages ? 'disabled' : ''}>Próxima ›</button></span>`;
  $$('button', el).forEach((b) => (b.onclick = () => onPage(Number(b.dataset.p))));
  return el;
}

// ---------- Tarefas (progresso em segundo plano) ----------
const watchedJobs = new Map();
function watchJob(job, onDone) {
  watchedJobs.set(job.id, { job, onDone });
  renderDock();
  pollJobs();
}
const pollJobs = debounce(async () => {
  for (const [id, w] of watchedJobs) {
    if (w.job.status !== 'running') continue;
    try {
      w.job = await api('GET', `/jobs/${id}`);
    } catch {}
    if (w.job.status !== 'running') {
      w.onDone?.(w.job);
      toast(`${w.job.title}: ${w.job.status === 'done' ? 'concluída' : w.job.status === 'error' ? 'falhou' : 'concluída com erros'}`, w.job.status === 'error');
      setTimeout(() => {
        watchedJobs.delete(id);
        renderDock();
      }, w.job.failed ? 15000 : 5000);
    }
  }
  renderDock();
  if ([...watchedJobs.values()].some((w) => w.job.status === 'running')) pollJobs();
}, 700);

function renderDock() {
  $('#jobs-dock').innerHTML = [...watchedJobs.values()]
    .map(({ job: j }) => {
      const p = j.total ? Math.round((j.done / j.total) * 100) : j.status === 'running' ? 5 : 100;
      const cls = j.status === 'running' ? '' : j.status === 'error' ? 'error' : 'done';
      return `<div class="job ${cls}"><header><span>${esc(j.title)}</span><a href="#/tarefas/${j.id}">detalhes</a></header>
        <div class="bar"><i style="width:${p}%"></i></div>
        <div class="muted small">${j.total ? `${j.done}/${j.total}` : ''} ${j.failed ? `<span class="neg">· ${j.failed} erros</span>` : ''} ${esc(j.message || '')}</div></div>`;
    })
    .join('');
}

// ---------- Estado global ----------
let status = null;
async function loadStatus() {
  status = await api('GET', '/status');
  $('#account').innerHTML = status.connected
    ? `Conectado como <b>${esc(status.user.nickname)}</b>${status.mock ? ' <span class="badge warn">simulado</span>' : ''}`
    : `<a href="${status.configured ? '/auth/login' : '#/painel'}">Conectar ao Mercado Livre</a>`;
  for (const j of status.running) if (!watchedJobs.has(j.id)) watchJob(j);
  return status;
}

// ---------- Roteador ----------
const routes = {};
let currentRender = null;
async function router() {
  const [, page = 'painel', arg] = location.hash.split('/');
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.page === page));
  const view = $('#view');
  const fn = routes[page] || routes.painel;
  currentRender = () => fn(view, arg && decodeURIComponent(arg));
  await guard(currentRender);
}
window.addEventListener('hashchange', router);
const refresh = () => currentRender && guard(currentRender);

// ---------- Painel ----------
routes.painel = async (view) => {
  const st = await loadStatus();
  const s = await api('GET', '/settings');
  view.innerHTML = `
    <div class="page-head"><div><h1>Painel</h1><div class="muted">Conexão, sincronização e regras de lucro</div></div></div>
    <div class="grid cols-2">
      <section class="card">
        <h2>Mercado Livre</h2>
        ${
          st.connected
            ? `<p>Conta conectada: <b>${esc(st.user.nickname)}</b> <span class="muted">(ID ${st.user.id})</span></p>
               <div class="toolbar"><button id="logout" class="danger">Desconectar</button></div>`
            : st.configured
              ? `<p>Autorize o aplicativo a acessar sua conta de vendedor.</p>
                 <div class="toolbar"><a class="btn primary" href="/auth/login">Conectar ao Mercado Livre</a></div>
                 ${st.mock ? '' : `<details><summary class="small muted">Colar código de autorização manualmente</summary>
                   <p class="help">Se o redirecionamento não voltar para este app, copie o parâmetro <code>code</code> da URL de retorno e cole aqui.</p>
                   <div class="inline"><input id="code" placeholder="TG-..." class="search"><button id="send-code">Enviar</button></div></details>`}`
              : `<p class="neg">Configure <code>ML_CLIENT_ID</code>, <code>ML_CLIENT_SECRET</code> e <code>ML_REDIRECT_URI</code> no arquivo <code>.env</code> e reinicie o servidor.</p>`
        }
        <div class="stats" style="margin-top:12px">
          <div class="stat"><b>${st.counts.products}</b><span>produtos</span></div>
          <div class="stat"><b>${st.counts.listings}</b><span>anúncios</span></div>
          <div class="stat"><b>${st.counts.linked}</b><span>anúncios vinculados</span></div>
          <div class="stat"><b>${st.counts.promotions}</b><span>campanhas</span></div>
        </div>
        <h2 style="margin-top:20px">Sincronização</h2>
        <div class="toolbar">
          <button id="sync-listings" class="primary" ${st.connected ? '' : 'disabled'}>Importar anúncios</button>
          <button id="sync-promos" class="primary" ${st.connected ? '' : 'disabled'}>Importar campanhas</button>
          <button id="sync-ship" ${st.connected ? '' : 'disabled'}>Atualizar fretes</button>
          ${st.mock ? '<button id="seed">Gerar produtos de exemplo</button>' : ''}
        </div>
        <p class="small muted">Anúncios: ${date(st.last_sync.listings)} · Campanhas: ${date(st.last_sync.promotions)}</p>
        <p class="help">Importar anúncios também busca a comissão de cada categoria/tipo de anúncio e o custo do frete grátis. Importar campanhas traz as campanhas disponíveis e os anúncios candidatos de cada uma.</p>
      </section>

      <section class="card">
        <h2>Regras de lucro</h2>
        <form id="settings">
          <div class="form-grid">
            <label class="field">Lucro líquido mínimo (R$)<input name="default_min_profit" value="${s.default_min_profit}"></label>
            <label class="field">Margem líquida mínima (%)<input name="default_min_margin_percent" value="${s.default_min_margin_percent}"></label>
            <label class="field">Percentual geral padrão (%)<input name="default_percent" value="${s.default_percent}"></label>
          </div>
          <p class="help">Lucro líquido = <b>valor que você recebe do Mercado Livre</b> − custo do produto. O valor recebido (já sem tarifa e frete) é calculado automaticamente com os dados do Mercado Livre. Um anúncio é viável quando atende o lucro líquido mínimo <b>e</b> a margem mínima (use 0 para ignorar uma das regras). Produtos podem ter regras próprias.</p>
          <details style="margin:8px 0 12px">
            <summary class="small muted" style="cursor:pointer">Ajustes avançados (normalmente não é preciso mexer)</summary>
            <div class="form-grid" style="margin-top:12px">
              <label class="field">Impostos sobre a venda (%)<input name="tax_percent" value="${s.tax_percent}"></label>
              <label class="field">Tarifa usada se o ML não informar (%)<input name="default_fee_percent" value="${s.default_fee_percent}"></label>
              <label class="field">Frete usado se o ML não informar (R$)<input name="default_shipping_cost" value="${s.default_shipping_cost}"></label>
              <label class="field">Frete grátis a partir de (R$)<input name="free_shipping_threshold" value="${s.free_shipping_threshold}"></label>
            </div>
            <p class="help">Custo fixo por venda cobrado pelo ML abaixo de cada faixa de preço (usado ao simular preços promocionais):</p>
            <div id="bands">${s.fixed_fee_bands.map((b) => bandRow(b)).join('')}</div>
            <div class="toolbar" style="margin-top:8px"><button type="button" id="add-band" class="link">+ adicionar faixa</button></div>
            <label class="inline"><input type="checkbox" name="fetch_shipping_costs" ${s.fetch_shipping_costs ? 'checked' : ''}> Consultar o frete de cada anúncio ao importar</label>
            <p class="inline" style="gap:12px">Importar anúncios com status:
              ${['active', 'paused'].map((x) => `<label class="inline"><input type="checkbox" name="sync_statuses" value="${x}" ${s.sync_statuses.includes(x) ? 'checked' : ''}> ${x === 'active' ? 'ativos' : 'pausados'}</label>`).join('')}
            </p>
          </details>
          <div class="toolbar"><button class="primary">Salvar regras</button></div>
        </form>
      </section>
    </div>`;

  const run = (path, then) => async () => {
    const job = await guard(() => api('POST', path));
    if (job) watchJob(job, () => (then ? then() : refresh()));
  };
  $('#sync-listings') && ($('#sync-listings').onclick = run('/sync/listings'));
  $('#sync-promos') && ($('#sync-promos').onclick = run('/sync/promotions'));
  $('#sync-ship') && ($('#sync-ship').onclick = run('/sync/shipping'));
  $('#seed') &&
    ($('#seed').onclick = () =>
      guard(async () => {
        const r = await api('POST', '/mock/seed-products');
        toast(`${r.created} produtos criados, ${r.updated} atualizados`);
        refresh();
      }));
  $('#logout') && ($('#logout').onclick = async () => (await confirmModal('Desconectar conta', 'Os dados importados serão mantidos.')) && guard(async () => (await api('POST', '/auth/logout'), refresh())));
  $('#send-code') &&
    ($('#send-code').onclick = () =>
      guard(async () => {
        await api('POST', '/auth/code', { code: $('#code').value });
        toast('Conta conectada');
        refresh();
      }));
  $('#add-band').onclick = () => $('#bands').insertAdjacentHTML('beforeend', bandRow({ up_to: '', fee: '' }));
  $('#bands').onclick = (e) => e.target.matches('.rm-band') && e.target.closest('.band').remove();
  $('#settings').onsubmit = (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const body = {};
    for (const k of ['default_min_margin_percent', 'default_min_profit', 'tax_percent', 'default_fee_percent', 'default_shipping_cost', 'free_shipping_threshold', 'default_percent']) body[k] = f.get(k);
    body.fetch_shipping_costs = f.get('fetch_shipping_costs') === 'on';
    body.sync_statuses = f.getAll('sync_statuses');
    body.fixed_fee_bands = $$('.band').map((b) => ({ up_to: $('[data-k=up_to]', b).value, fee: $('[data-k=fee]', b).value }));
    guard(async () => {
      await api('PUT', '/settings', body);
      toast('Regras salvas');
    });
  };
};
const bandRow = (b) =>
  `<div class="band inline" style="margin-bottom:6px">Abaixo de R$ <input class="w-num" data-k="up_to" value="${b.up_to}"> cobrar R$ <input class="w-num" data-k="fee" value="${b.fee}"> <button type="button" class="link rm-band">remover</button></div>`;

// ---------- Produtos ----------
const prodState = { search: '', page: 1 };
routes.produtos = async (view) => {
  view.innerHTML = `
    <div class="page-head"><div><h1>Produtos</h1><div class="muted">Custo e lucro mínimo de cada produto</div></div>
      <div class="toolbar"><button id="import">Importar CSV</button><button id="new" class="primary">Novo produto</button></div></div>
    <div class="toolbar"><input id="search" class="search" type="search" placeholder="Buscar por SKU ou nome" value="${esc(prodState.search)}"></div>
    <div id="list"></div>`;
  const load = async () => {
    const r = await api('GET', `/products?${qs({ search: prodState.search, page: prodState.page, pageSize: 50 })}`);
    const list = $('#list');
    list.innerHTML = r.rows.length
      ? `<div class="table-wrap"><table><thead><tr><th>SKU</th><th>Nome</th><th class="num">Custo</th><th class="num">Margem mín.</th><th class="num">Lucro mín.</th><th class="num">Anúncios</th><th></th></tr></thead><tbody>
        ${r.rows
          .map(
            (p) => `<tr data-id="${p.id}"><td class="nowrap"><b>${esc(p.sku)}</b></td><td>${esc(p.name)}</td><td class="num">${money(p.cost)}</td>
            <td class="num">${p.min_margin_percent === null ? '<span class="muted">padrão</span>' : pct(p.min_margin_percent)}</td>
            <td class="num">${p.min_profit === null ? '<span class="muted">padrão</span>' : money(p.min_profit)}</td>
            <td class="num"><a href="#/anuncios/produto:${p.id}">${p.listings}</a></td>
            <td class="nowrap"><button class="link edit">editar</button><button class="link danger del">excluir</button></td></tr>`
          )
          .join('')}</tbody></table></div>`
      : `<div class="card empty">Nenhum produto. Cadastre manualmente ou importe um CSV.</div>`;
    list.append(pager(r.total, prodState.page, 50, (p) => ((prodState.page = p), load())));
    $$('.edit', list).forEach((b) => (b.onclick = () => editProduct(r.rows.find((p) => p.id == b.closest('tr').dataset.id)).then(load)));
    $$('.del', list).forEach(
      (b) =>
        (b.onclick = async () => {
          const p = r.rows.find((x) => x.id == b.closest('tr').dataset.id);
          if (await confirmModal('Excluir produto', `Excluir <b>${esc(p.sku)}</b>? Os vínculos com ${p.listings} anúncio(s) serão removidos.`, 'Excluir')) guard(async () => (await api('DELETE', `/products/${p.id}`), load()));
        })
    );
  };
  $('#search').oninput = debounce((e) => ((prodState.search = e.target.value), (prodState.page = 1), guard(load)));
  $('#new').onclick = () => editProduct().then(load);
  $('#import').onclick = async () => {
    const f = await modal(
      `<h2>Importar produtos (CSV)</h2>
       <p class="help">Colunas: <code>sku;nome;custo;margem_minima;lucro_minimo</code> (as duas últimas são opcionais). Produtos com SKU existente são atualizados. Aceita vírgula decimal.</p>
       <input type="file" accept=".csv,.txt" id="file"><textarea name="csv" placeholder="sku;nome;custo;margem_minima;lucro_minimo&#10;ABC-001;Camiseta preta P;32,90;15;5"></textarea>
       <div class="actions"><button value="cancel">Cancelar</button><button value="ok" class="primary">Importar</button></div>`,
      { onOpen: (form) => ($('#file', form).onchange = async (e) => ($('textarea', form).value = await e.target.files[0].text())) }
    );
    if (!f?.csv) return;
    const r = await guard(() => api('POST', '/products/import', f.csv));
    if (r) {
      toast(`${r.created} criados, ${r.updated} atualizados${r.errors.length ? `, ${r.errors.length} erros` : ''}`, r.errors.length > 0);
      if (r.errors.length) await modal(`<h2>Erros na importação</h2><div class="log">${r.errors.map((e) => `<div class="bad">${esc(e)}</div>`).join('')}</div><div class="actions"><button value="ok">Fechar</button></div>`);
      load();
    }
  };
  await load();
};

async function editProduct(p = {}) {
  const f = await modal(`<h2>${p.id ? 'Editar produto' : 'Novo produto'}</h2>
    <div class="form-grid">
      <label class="field">SKU<input name="sku" required value="${esc(p.sku || '')}"></label>
      <label class="field">Nome<input name="name" value="${esc(p.name || '')}"></label>
      <label class="field">Custo (R$)<input name="cost" required value="${p.cost ?? ''}"></label>
      <label class="field">Margem mínima (%)<input name="min_margin_percent" placeholder="padrão" value="${p.min_margin_percent ?? ''}"></label>
      <label class="field">Lucro mínimo por unidade (R$)<input name="min_profit" placeholder="padrão" value="${p.min_profit ?? ''}"></label>
    </div>
    <p class="help">Deixe margem/lucro em branco para usar as regras padrão do Painel.</p>
    <div class="actions"><button value="cancel" formnovalidate>Cancelar</button><button value="ok" class="primary">Salvar</button></div>`);
  if (!f) return;
  await guard(async () => {
    await api(p.id ? 'PUT' : 'POST', p.id ? `/products/${p.id}` : '/products', f);
    toast('Produto salvo');
  });
}

// ---------- Anúncios ----------
const lstState = { search: '', linked: '', status: '', page: 1, pageSize: 50, selected: new Set(), allFilter: false, productId: '' };
let productsCache = null;
async function productOptions() {
  productsCache = await api('GET', '/products/all');
  return productsCache.map((p) => `<option value="${esc(p.sku)} — ${esc(p.name)}"></option>`).join('');
}
const productFromInput = (v) => productsCache?.find((p) => `${p.sku} — ${p.name}` === v || p.sku.toLowerCase() === String(v).trim().toLowerCase());

routes.anuncios = async (view, arg) => {
  if (arg?.startsWith('produto:')) {
    lstState.productId = arg.split(':')[1];
    lstState.page = 1;
  } else if (arg) return listingDetail(view, arg);
  else lstState.productId = '';
  view.innerHTML = `
    <div class="page-head"><div><h1>Anúncios</h1><div class="muted">Vincule produtos aos anúncios para calcular custo e lucro</div></div>
      <div class="toolbar"><button id="import-links">Importar vínculos CSV</button><button id="autolink" class="primary">Vincular automaticamente por SKU</button></div></div>
    <div class="toolbar">
      <input id="search" class="search" type="search" placeholder="Buscar por título, MLB, SKU… (várias palavras)" value="${esc(lstState.search)}">
      <select id="linked"><option value="">Todos</option><option value="no">Sem produto vinculado</option><option value="yes">Com produto vinculado</option></select>
      <select id="status"><option value="">Qualquer status</option><option value="active">Ativos</option><option value="paused">Pausados</option></select>
      ${lstState.productId ? `<span class="badge info">Filtrando por produto <button class="link" id="clear-prod">✕</button></span>` : ''}
    </div>
    <div id="bulk"></div><div id="list"></div>`;
  $('#linked').value = lstState.linked;
  $('#status').value = lstState.status;
  const opts = await productOptions();

  const filter = () => ({ search: lstState.search, linked: lstState.linked, status: lstState.status, productId: lstState.productId });
  const selCount = (total) => (lstState.allFilter ? total : lstState.selected.size);
  const selection = () => (lstState.allFilter ? { filter: filter() } : { listing_ids: [...lstState.selected] });

  const load = async () => {
    const r = await api('GET', `/listings?${qs({ ...filter(), page: lstState.page, pageSize: lstState.pageSize })}`);
    const n = selCount(r.total);
    $('#bulk').innerHTML = n
      ? `<div class="bulkbar"><b>${n.toLocaleString('pt-BR')} selecionado(s)</b>
          ${!lstState.allFilter && r.total > r.rows.length ? `<button class="link" id="sel-all">Selecionar todos os ${r.total.toLocaleString('pt-BR')} do filtro</button>` : ''}
          <span class="grow"></span>
          <input list="plist" id="prod" placeholder="Produto (SKU ou nome)" class="search">
          <datalist id="plist">${opts}</datalist>
          <label class="inline">Qtd <input id="qty" class="w-num" value="1" style="width:60px"></label>
          <select id="mode"><option value="replace">Substituir vínculo</option><option value="add">Adicionar ao kit</option></select>
          <button class="primary" id="do-link">Vincular</button>
          <button class="danger" id="do-unlink">Desvincular</button>
          <button class="link" id="sel-clear">Limpar seleção</button></div>`
      : '';
    const list = $('#list');
    list.innerHTML = r.rows.length
      ? `<div class="table-wrap"><table><thead><tr><th class="check"><input type="checkbox" id="chk-all"></th><th>Anúncio</th><th>SKU</th><th>Produto(s)</th>
        <th class="num">Preço</th><th class="num">Custo</th><th class="num">Você recebe</th><th class="num">Lucro líquido</th><th class="num">Preço mín. viável</th><th class="num">Desc. máx.</th><th class="num">Campanhas</th></tr></thead><tbody>
        ${r.rows
          .map((l) => {
            const sel = lstState.allFilter || lstState.selected.has(l.id);
            return `<tr data-id="${l.id}" class="${sel ? 'selected' : ''}"><td class="check"><input type="checkbox" class="chk" ${sel ? 'checked' : ''}></td>
            <td><div class="item-cell"><img class="thumb" loading="lazy" src="${esc(l.thumbnail || '')}" alt=""><div><div class="t"><a href="#/anuncios/${l.id}">${esc(l.title)}</a></div>
              <div class="small muted">${l.id} · ${l.status === 'active' ? 'ativo' : esc(l.status)} · ${l.available_quantity ?? 0} un.</div></div></div></td>
            <td class="small nowrap">${esc(l.sku || '—')}</td>
            <td class="small">${l.products ? esc(l.products) : '<span class="badge warn">sem vínculo</span>'}</td>
            <td class="num">${money(l.price)}</td><td class="num">${money(l.cost)}</td><td class="num">${money(l.current_net)}</td>
            <td class="num">${l.current_profit === null ? '—' : `${signed(l.current_profit)}<div class="small muted">${pct(l.current_margin)}</div>`}</td>
            <td class="num">${money(l.min_viable_price)}</td>
            <td class="num">${l.max_discount === null ? '—' : pct(l.max_discount)}</td>
            <td class="num small">${l.in_promotions ? `<span class="badge ok">${l.in_promotions} ativa(s)</span>` : ''} ${l.candidate_promotions ? `<span class="muted">${l.candidate_promotions} cand.</span>` : ''}</td></tr>`;
          })
          .join('')}</tbody></table></div>`
      : `<div class="card empty">Nenhum anúncio encontrado. ${status?.counts.listings ? '' : 'Importe seus anúncios no Painel.'}</div>`;
    list.append(pager(r.total, lstState.page, lstState.pageSize, (p) => ((lstState.page = p), guard(load))));

    $('#chk-all') && ($('#chk-all').checked = r.rows.length > 0 && r.rows.every((l) => lstState.allFilter || lstState.selected.has(l.id)));
    $('#chk-all') &&
      ($('#chk-all').onchange = (e) => {
        lstState.allFilter = false;
        r.rows.forEach((l) => (e.target.checked ? lstState.selected.add(l.id) : lstState.selected.delete(l.id)));
        guard(load);
      });
    $$('.chk', list).forEach(
      (c) =>
        (c.onchange = () => {
          const id = c.closest('tr').dataset.id;
          if (lstState.allFilter) {
            lstState.allFilter = false;
            r.rows.forEach((l) => lstState.selected.add(l.id));
          }
          c.checked ? lstState.selected.add(id) : lstState.selected.delete(id);
          guard(load);
        })
    );
    $('#sel-all') && ($('#sel-all').onclick = () => ((lstState.allFilter = true), guard(load)));
    $('#sel-clear') && ($('#sel-clear').onclick = () => ((lstState.allFilter = false), lstState.selected.clear(), guard(load)));
    $('#do-link') &&
      ($('#do-link').onclick = () => {
        const p = productFromInput($('#prod').value);
        if (!p) return toast('Escolha um produto da lista', true);
        guard(async () => {
          const res = await api('POST', '/listings/link', { ...selection(), product_id: p.id, quantity: $('#qty').value, mode: $('#mode').value });
          toast(`${res.linked} anúncio(s) vinculados a ${p.sku}`);
          lstState.selected.clear();
          lstState.allFilter = false;
          load();
        });
      });
    $('#do-unlink') &&
      ($('#do-unlink').onclick = async () => {
        if (!(await confirmModal('Desvincular', `Remover o vínculo de produto de ${n} anúncio(s)?`, 'Desvincular'))) return;
        guard(async () => {
          await api('POST', '/listings/unlink', selection());
          lstState.selected.clear();
          lstState.allFilter = false;
          load();
        });
      });
  };

  const resetAndLoad = () => {
    lstState.page = 1;
    lstState.allFilter = false;
    guard(load);
  };
  $('#search').oninput = debounce((e) => ((lstState.search = e.target.value), resetAndLoad()));
  $('#linked').onchange = (e) => ((lstState.linked = e.target.value), resetAndLoad());
  $('#status').onchange = (e) => ((lstState.status = e.target.value), resetAndLoad());
  $('#clear-prod') && ($('#clear-prod').onclick = () => (location.hash = '#/anuncios'));
  $('#autolink').onclick = async () => {
    const f = await modal(`<h2>Vincular automaticamente por SKU</h2>
      <p>Liga cada anúncio ao produto cujo SKU é igual ao SKU do anúncio (campo SKU / SELLER_SKU no Mercado Livre).</p>
      <ul class="help"><li><code>ABC</code> → produto ABC x1</li><li><code>ABC-KIT3</code>, <code>ABC_X3</code>, <code>ABC*3</code> → produto ABC x3 (se ABC-KIT3 não existir como produto)</li><li><code>ABC+DEF</code> → kit com ABC e DEF</li></ul>
      <label class="inline"><input type="checkbox" name="overwrite"> Sobrescrever vínculos existentes</label>
      <div class="actions"><button value="cancel">Cancelar</button><button value="ok" class="primary">Vincular</button></div>`);
    if (!f) return;
    const r = await guard(() => api('POST', '/listings/auto-link', { overwrite: f.overwrite === 'on' }));
    if (r) toast(`${r.linked} vinculados · ${r.not_found} SKUs sem produto · ${r.skipped} já tinham vínculo`);
    resetAndLoad();
  };
  $('#import-links').onclick = async () => {
    const f = await modal(
      `<h2>Importar vínculos (CSV)</h2>
       <p class="help">Colunas: <code>anuncio;sku;quantidade</code>. Um anúncio pode aparecer em várias linhas para formar um kit. Os vínculos dos anúncios presentes no arquivo são substituídos.</p>
       <input type="file" accept=".csv,.txt" id="file"><textarea name="csv" placeholder="anuncio;sku;quantidade&#10;MLB1234567890;ABC-001;2"></textarea>
       <div class="actions"><button value="cancel">Cancelar</button><button value="ok" class="primary">Importar</button></div>`,
      { onOpen: (form) => ($('#file', form).onchange = async (e) => ($('textarea', form).value = await e.target.files[0].text())) }
    );
    if (!f?.csv) return;
    const r = await guard(() => api('POST', '/listings/import-links', f.csv));
    if (r) {
      toast(`${r.linked} anúncios vinculados${r.errors.length ? `, ${r.errors.length} erros` : ''}`, r.errors.length > 0);
      if (r.errors.length) await modal(`<h2>Erros</h2><div class="log">${r.errors.map((e) => `<div class="bad">${esc(e)}</div>`).join('')}</div><div class="actions"><button value="ok">Fechar</button></div>`);
    }
    resetAndLoad();
  };
  await load();
};

async function listingDetail(view, id) {
  const l = await api('GET', `/listings/${id}`);
  const opts = await productOptions();
  view.innerHTML = `
    <div class="page-head"><div><a href="#/anuncios" class="small">‹ Anúncios</a><h1>${esc(l.title)}</h1>
      <div class="muted">${l.id} · <a href="${esc(l.permalink)}" target="_blank" rel="noopener">ver no Mercado Livre</a> · SKU ${esc(l.sku || '—')}</div></div></div>
    <div class="grid cols-2">
      <section class="card"><h2>Composição (produtos vinculados)</h2>
        ${l.components.length ? `<table><thead><tr><th>SKU</th><th>Produto</th><th class="num">Qtd</th><th class="num">Custo</th></tr></thead><tbody>
          ${l.components.map((c) => `<tr><td>${esc(c.sku)}</td><td>${esc(c.name)}</td><td class="num">${c.quantity}</td><td class="num">${money(c.cost * c.quantity)}</td></tr>`).join('')}
          </tbody></table>` : '<p class="badge warn">Sem produto vinculado</p>'}
        <div class="toolbar" style="margin-top:12px">
          <input list="plist" id="prod" placeholder="Produto (SKU ou nome)" class="search"><datalist id="plist">${opts}</datalist>
          <label class="inline">Qtd <input id="qty" class="w-num" value="1" style="width:60px"></label>
          <button id="add" class="primary">Adicionar ao kit</button><button id="replace">Substituir</button>
          ${l.components.length ? '<button id="unlink" class="danger">Desvincular</button>' : ''}
        </div>
      </section>
      <section class="card"><h2>Custos e viabilidade</h2>
        <dl class="kv">
          <dt>Preço atual</dt><dd>${money(l.price)}</dd>
          <dt>Custo dos produtos</dt><dd>${money(l.cost)}</dd>
          <dt>Você recebe do ML</dt><dd><b>${money(l.current_net)}</b> <span class="muted small">(tarifa ${pct(l.fee_percent)} · frete ${money(l.shipping_effective)})</span></dd>
          <dt>Regra</dt><dd>lucro líquido ≥ ${money(l.min_profit_rule)} e margem ≥ ${pct(l.min_margin_rule)}</dd>
          <dt>Lucro líquido atual</dt><dd>${signed(l.current_profit)} (${pct(l.current_margin)})</dd>
          <dt>Preço mínimo viável</dt><dd><b>${money(l.min_viable_price)}</b></dd>
          <dt>Desconto máximo viável</dt><dd><b>${pct(l.max_discount)}</b></dd>
        </dl>
        <details style="margin-top:16px"><summary class="small muted" style="cursor:pointer">Corrigir tarifa ou frete deste anúncio (se o valor recebido não bater com o ML)</summary>
        <form id="ov" class="form-grid" style="margin-top:12px">
          <label class="field">Frete fixo (R$)<input name="shipping_cost_override" placeholder="automático" value="${l.shipping_cost_override ?? ''}"></label>
          <label class="field">Comissão (%)<input name="fee_percent_override" placeholder="automático" value="${l.fee_percent_override ?? ''}"></label>
          <div style="align-self:end"><button class="primary">Salvar ajustes</button></div>
        </form></details>
      </section>
    </div>`;
  const link = (mode) => {
    const p = productFromInput($('#prod').value);
    if (!p) return toast('Escolha um produto da lista', true);
    guard(async () => {
      await api('POST', '/listings/link', { listing_ids: [id], product_id: p.id, quantity: $('#qty').value, mode });
      listingDetail(view, id);
    });
  };
  $('#add').onclick = () => link('add');
  $('#replace').onclick = () => link('replace');
  $('#unlink') && ($('#unlink').onclick = () => guard(async () => (await api('POST', '/listings/unlink', { listing_ids: [id] }), listingDetail(view, id))));
  $('#ov').onsubmit = (e) => {
    e.preventDefault();
    guard(async () => {
      await api('PUT', `/listings/${id}`, Object.fromEntries(new FormData(e.target)));
      toast('Ajustes salvos');
      listingDetail(view, id);
    });
  };
}

// ---------- Campanhas ----------
const campState = { selected: new Set(), strategy: 'percent', percent: null };
const statusBadge = (s) =>
  ({ started: '<span class="badge ok">ativa</span>', pending: '<span class="badge info">programada</span>', finished: '<span class="badge neutral">encerrada</span>' })[s] ||
  `<span class="badge neutral">${esc(s || '—')}</span>`;

routes.campanhas = async (view, arg) => {
  if (arg) return campaignDetail(view, arg);
  const settings = await api('GET', '/settings');
  campState.percent ??= settings.default_percent;
  const { rows, strategies } = await api('GET', '/promotions');
  view.innerHTML = `
    <div class="page-head"><div><h1>Campanhas</h1><div class="muted">Campanhas disponíveis na sua conta do Mercado Livre</div></div>
      <div class="toolbar"><button id="sync" class="primary" ${status?.connected ? '' : 'disabled'}>Importar campanhas</button></div></div>
    <div id="bulk"></div>
    ${
      rows.length
        ? `<div class="table-wrap"><table><thead><tr><th class="check"><input type="checkbox" id="chk-all"></th><th>Campanha</th><th>Tipo</th><th>Status</th><th>Período</th><th>Prazo p/ aderir</th>
        <th class="num">Candidatos</th><th class="num">Participando</th><th></th></tr></thead><tbody>
      ${rows
        .map(
          (p) => `<tr data-id="${esc(p.id)}" class="clickable ${campState.selected.has(p.id) ? 'selected' : ''}"><td class="check"><input type="checkbox" class="chk" ${campState.selected.has(p.id) ? 'checked' : ''}></td>
          <td><a href="#/campanhas/${encodeURIComponent(p.id)}"><b>${esc(p.name || p.id)}</b></a><div class="small muted">${esc(p.id)}${p.benefits?.meli_percent ? ` · ML cobre ${p.benefits.meli_percent}%` : ''}</div></td>
          <td>${esc(p.type_label)}${p.settable ? '' : ' <span class="small muted">(preço fixo)</span>'}</td><td>${statusBadge(p.status)}</td>
          <td class="small nowrap">${date(p.start_date)} → ${date(p.finish_date)}</td><td class="small nowrap">${date(p.deadline_date)}</td>
          <td class="num">${p.candidates ?? 0}</td><td class="num">${p.participating ?? 0}</td>
          <td><a class="btn" href="#/campanhas/${encodeURIComponent(p.id)}">Abrir</a></td></tr>`
        )
        .join('')}</tbody></table></div>`
        : `<div class="card empty">Nenhuma campanha importada. ${status?.connected ? 'Clique em "Importar campanhas".' : 'Conecte sua conta no Painel.'}</div>`
    }`;
  const renderBulk = () => {
    const n = campState.selected.size;
    $('#bulk').innerHTML = n
      ? `<div class="bulkbar"><b>${n} campanha(s) selecionada(s)</b><span class="grow"></span>
        <select id="b-strategy">${Object.entries(strategies).map(([k, v]) => `<option value="${k}" ${k === campState.strategy ? 'selected' : ''}>${v}</option>`).join('')}</select>
        <label class="inline">Percentual <input id="b-percent" class="w-num" value="${campState.percent}">%</label>
        <button class="primary" id="b-apply">Incluir todos os viáveis</button><button class="link" id="b-clear">Limpar</button></div>`
      : '';
    if (!n) return;
    $('#b-strategy').onchange = (e) => (campState.strategy = e.target.value);
    $('#b-percent').oninput = (e) => (campState.percent = e.target.value);
    $('#b-clear').onclick = () => (campState.selected.clear(), refresh());
    $('#b-apply').onclick = async () => {
      if (!(await confirmModal('Incluir em várias campanhas', `Incluir todos os anúncios <b>viáveis</b> nas ${n} campanhas selecionadas usando <b>${strategies[campState.strategy]}</b>${campState.strategy === 'percent' ? ` de <b>${esc(campState.percent)}%</b>` : ''}?<p class="help">Campanhas de preço fixo (co-participadas, automatizadas) usam o preço da própria campanha. Anúncios inviáveis ou sem produto vinculado são ignorados.</p>`, 'Incluir'))) return;
      const job = await guard(() => api('POST', '/promotions/apply', { promotion_ids: [...campState.selected], strategy: campState.strategy, percent: campState.percent }));
      if (job) watchJob(job, refresh);
    };
  };
  renderBulk();
  $('#sync').onclick = async () => {
    const job = await guard(() => api('POST', '/sync/promotions'));
    if (job) watchJob(job, refresh);
  };
  $('#chk-all') &&
    ($('#chk-all').onchange = (e) => {
      rows.forEach((p) => (e.target.checked ? campState.selected.add(p.id) : campState.selected.delete(p.id)));
      refresh();
    });
  $$('.chk').forEach(
    (c) =>
      (c.onchange = () => {
        const tr = c.closest('tr');
        c.checked ? campState.selected.add(tr.dataset.id) : campState.selected.delete(tr.dataset.id);
        tr.classList.toggle('selected', c.checked);
        renderBulk();
      })
  );
};

const detState = { id: null, filter: 'candidate', search: '', page: 1, pageSize: 100, sort: '', dir: 'asc', selected: new Set() };
async function campaignDetail(view, id) {
  if (detState.id !== id) Object.assign(detState, { id, filter: 'candidate', search: '', page: 1, sort: '', selected: new Set() });
  const settings = await api('GET', '/settings');
  campState.percent ??= settings.default_percent;
  const { strategies } = await api('GET', '/promotions');

  view.innerHTML = `<div id="head"></div>
    <section class="card" style="margin-bottom:12px"><div class="strategy" id="strategy"></div></section>
    <div class="chips" id="chips"></div>
    <div class="toolbar"><input id="search" class="search" type="search" placeholder="Buscar anúncio, MLB ou SKU" value="${esc(detState.search)}"></div>
    <div id="bulk"></div><div id="list"></div>`;

  let last = null;
  const params = () => ({ strategy: campState.strategy, percent: campState.percent, filter: detState.filter, search: detState.search, page: detState.page, pageSize: detState.pageSize, sort: detState.sort, dir: detState.dir });

  const load = async () => {
    const r = (last = await api('GET', `/promotions/${encodeURIComponent(id)}/evaluate?${qs(params())}`));
    const p = r.promo;
    const benefits = p.benefits ? JSON.parse(p.benefits) : null;
    $('#head').innerHTML = `<div class="page-head"><div><a href="#/campanhas" class="small">‹ Campanhas</a><h1>${esc(p.name || p.id)}</h1>
      <div class="promo-head muted"><span>${esc(p.type_label)}</span>${statusBadge(p.status)}<span>${date(p.start_date)} → ${date(p.finish_date)}</span>
      ${p.deadline_date ? `<span>aderir até ${date(p.deadline_date)}</span>` : ''}${benefits?.meli_percent ? `<span>ML ${benefits.meli_percent}% + vendedor ${benefits.seller_percent}%</span>` : ''}
      <span class="small">itens atualizados ${date(p.items_synced_at)}</span></div></div>
      <div class="toolbar"><button id="resync">Atualizar anúncios da campanha</button></div></div>`;
    $('#resync').onclick = async () => {
      const job = await guard(() => api('POST', `/sync/promotions/${encodeURIComponent(id)}`));
      if (job) watchJob(job, () => guard(load));
    };

    $('#strategy').innerHTML = p.settable
      ? `<label class="field">Como definir o preço
          <select id="strat">${Object.entries(strategies).map(([k, v]) => `<option value="${k}" ${k === campState.strategy ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <label class="field" ${campState.strategy === 'percent' ? '' : 'hidden'}>Percentual geral de desconto
          <span class="inline"><input id="percent" class="w-num" type="number" step="0.5" min="0" max="90" value="${esc(campState.percent)}">%</span></label>
        <p class="help" style="margin:0">${
          campState.strategy === 'percent'
            ? 'Aplica o mesmo desconto a todos os anúncios. Se ficar fora da faixa permitida pela campanha, o preço é ajustado ao limite.'
            : campState.strategy === 'max_viable'
              ? 'Para cada anúncio, usa o maior desconto que ainda respeita o lucro e a margem mínimos (dentro da faixa da campanha).'
              : 'Usa o preço sugerido pelo Mercado Livre para cada anúncio.'
        }</p>`
      : `<p class="help" style="margin:0">Nesta campanha o preço é definido pelo Mercado Livre${benefits?.meli_percent ? ` (desconto total de ${benefits.meli_percent + benefits.seller_percent}%, sendo ${benefits.meli_percent}% custeado pelo ML)` : ''}. A viabilidade considera o valor que você efetivamente recebe.</p>`;
    if ($('#strat'))
      $('#strat').onchange = (e) => {
        campState.strategy = e.target.value;
        detState.page = 1;
        guard(load);
      };
    if ($('#percent'))
      $('#percent').oninput = debounce((e) => {
        campState.percent = e.target.value;
        detState.page = 1;
        guard(load);
      }, 300);

    const s = r.summary;
    const chips = [
      ['candidate', 'Candidatos', s.total - s.participating],
      ['viable', 'Viáveis', s.viable],
      ['not_viable', 'Inviáveis', s.not_viable],
      ['unlinked', 'Sem vínculo', s.unlinked],
      ['participating', 'Participando', s.participating],
      ['all', 'Todos', s.total],
    ];
    $('#chips').innerHTML = chips.map(([k, label, n]) => `<button class="chip ${detState.filter === k ? 'active' : ''}" data-f="${k}">${label}<b>${n}</b></button>`).join('');
    $$('.chip').forEach((c) => (c.onclick = () => ((detState.filter = c.dataset.f), (detState.page = 1), detState.selected.clear(), guard(load))));

    const selN = detState.selected.size;
    const selectedRows = () => [...detState.selected];
    $('#bulk').innerHTML = `<div class="bulkbar">
        <button class="primary" id="apply-all" ${s.viable ? '' : 'disabled'}>Incluir todos os viáveis (${s.viable})</button>
        ${selN ? `<b>${selN} selecionado(s)</b><button id="apply-sel">Incluir selecionados</button>
          <label class="inline small"><input type="checkbox" id="force"> permitir inviáveis</label>
          <button class="danger" id="remove-sel">Remover selecionados da campanha</button><button class="link" id="clear">Limpar seleção</button>` : ''}
        ${r.total > r.rows.length || (r.total && !selN) ? `<button class="link" id="sel-filter">Selecionar os ${r.total} do filtro</button>` : ''}
        <span class="grow"></span>${s.participating ? `<button class="link danger" id="remove-all">Remover todos (${s.participating})</button>` : ''}</div>`;

    const doApply = async (listingIds, onlyViable) => {
      const label = listingIds ? `${listingIds.length} anúncio(s) selecionado(s)` : `todos os <b>${s.viable}</b> anúncios viáveis`;
      const how = p.settable ? `${strategies[campState.strategy]}${campState.strategy === 'percent' ? ` de <b>${esc(campState.percent)}%</b>` : ''}` : 'preço da campanha';
      if (!(await confirmModal('Incluir na campanha', `Incluir ${label} em <b>${esc(p.name || p.id)}</b> usando ${how}?${onlyViable ? '<p class="help">Anúncios inviáveis serão ignorados.</p>' : '<p class="neg">Atenção: anúncios abaixo do lucro mínimo também serão incluídos.</p>'}`, 'Incluir'))) return;
      const job = await guard(() => api('POST', '/promotions/apply', { promotion_ids: [id], listing_ids: listingIds, strategy: campState.strategy, percent: campState.percent, only_viable: onlyViable }));
      if (job)
        watchJob(job, () => {
          detState.selected.clear();
          guard(load);
        });
    };
    const doRemove = async (listingIds) => {
      if (!(await confirmModal('Remover da campanha', `Remover ${listingIds ? `${listingIds.length} anúncio(s)` : 'todos os anúncios participantes'} de <b>${esc(p.name || p.id)}</b>?`, 'Remover'))) return;
      const job = await guard(() => api('POST', `/promotions/${encodeURIComponent(id)}/remove`, { listing_ids: listingIds }));
      if (job)
        watchJob(job, () => {
          detState.selected.clear();
          guard(load);
        });
    };
    $('#apply-all').onclick = () => doApply(undefined, true);
    $('#apply-sel') && ($('#apply-sel').onclick = () => doApply(selectedRows(), !$('#force').checked));
    $('#remove-sel') && ($('#remove-sel').onclick = () => doRemove(selectedRows()));
    $('#remove-all') && ($('#remove-all').onclick = () => doRemove(undefined));
    $('#clear') && ($('#clear').onclick = () => (detState.selected.clear(), guard(load)));
    $('#sel-filter') &&
      ($('#sel-filter').onclick = () =>
        guard(async () => {
          const all = await api('GET', `/promotions/${encodeURIComponent(id)}/evaluate?${qs({ ...params(), ids: 1, pageSize: 1 })}`);
          all.filtered_ids.forEach((x) => detState.selected.add(x));
          load();
        }));

    const th = (key, label, cls = 'num') => `<th class="sortable ${cls}" data-sort="${key}">${label}${detState.sort === key ? (detState.dir === 'asc' ? ' ▲' : ' ▼') : ''}</th>`;
    const list = $('#list');
    list.innerHTML = r.rows.length
      ? `<div class="table-wrap"><table><thead><tr><th class="check"><input type="checkbox" id="chk-all"></th>${th('title', 'Anúncio', '')}
        ${th('cost', 'Custo')}${th('original_price', 'Preço original')}<th class="num">Faixa permitida</th>${th('target_price', 'Preço promo')}${th('discount', 'Desc.')}
        ${th('profit', 'Lucro líq.')}${th('margin', 'Margem')}${th('min_viable_price', 'Preço mín.')}${th('max_viable_discount', 'Desc. máx.')}<th>Situação</th></tr></thead><tbody>
        ${r.rows
          .map(
            (x) => `<tr data-id="${x.listing_id}" class="${detState.selected.has(x.listing_id) ? 'selected' : ''}"><td class="check"><input type="checkbox" class="chk" ${detState.selected.has(x.listing_id) ? 'checked' : ''}></td>
          <td><div class="item-cell"><img class="thumb" loading="lazy" src="${esc(x.thumbnail || '')}" alt=""><div><div class="t"><a href="#/anuncios/${x.listing_id}">${esc(x.title)}</a></div><div class="small muted">${x.listing_id} · ${x.available_quantity ?? '—'} un. · ${x.products ? esc(x.products) : 'sem produto'}</div></div></div></td>
          <td class="num">${money(x.cost)}</td><td class="num">${money(x.original_price)}</td>
          <td class="num small muted">${x.min_allowed !== null ? `${money(x.min_allowed)} – ${money(x.max_allowed)}` : x.seller_percentage !== null ? `você ${pct(x.seller_percentage)} · ML ${pct(x.meli_percentage)}` : '—'}</td>
          <td class="num"><b>${money(x.target_price)}</b>${x.net !== null ? `<div class="small muted">você recebe ${money(x.net)}</div>` : ''}</td>
          <td class="num">${pct(x.discount)}</td>
          <td class="num">${signed(x.profit)}</td><td class="num">${signed(x.margin, pct)}</td>
          <td class="num">${money(x.min_viable_price)}</td><td class="num">${pct(x.max_viable_discount)}</td>
          <td class="status-cell">${x.participating ? `<span class="badge info">${x.status === 'started' ? 'participando' : 'programado'}</span>` : x.viable ? '<span class="badge ok">viável</span>' : `<span class="badge ${x.cost === null ? 'warn' : 'bad'}">${x.cost === null ? 'sem vínculo' : 'inviável'}</span>`}
            ${x.reason ? `<div class="small muted">${esc(x.reason)}</div>` : ''}</td></tr>`
          )
          .join('')}</tbody></table></div>`
      : `<div class="card empty">Nenhum anúncio neste filtro.</div>`;
    list.append(pager(r.total, detState.page, detState.pageSize, (pg) => ((detState.page = pg), guard(load))));

    $$('th.sortable', list).forEach(
      (h) =>
        (h.onclick = () => {
          detState.dir = detState.sort === h.dataset.sort && detState.dir === 'asc' ? 'desc' : 'asc';
          detState.sort = h.dataset.sort;
          guard(load);
        })
    );
    const allChk = $('#chk-all', list);
    if (allChk) {
      allChk.checked = r.rows.every((x) => detState.selected.has(x.listing_id));
      allChk.onchange = () => {
        r.rows.forEach((x) => (allChk.checked ? detState.selected.add(x.listing_id) : detState.selected.delete(x.listing_id)));
        guard(load);
      };
    }
    $$('.chk', list).forEach(
      (c) =>
        (c.onchange = () => {
          const lid = c.closest('tr').dataset.id;
          c.checked ? detState.selected.add(lid) : detState.selected.delete(lid);
          guard(load);
        })
    );
  };

  $('#search').oninput = debounce((e) => {
    detState.search = e.target.value;
    detState.page = 1;
    guard(load);
  });
  await load();
}

// ---------- Tarefas ----------
routes.tarefas = async (view, id) => {
  if (id) {
    const j = await api('GET', `/jobs/${id}`);
    view.innerHTML = `<div class="page-head"><div><a href="#/tarefas" class="small">‹ Tarefas</a><h1>${esc(j.title)}</h1>
      <div class="muted">${esc(j.status)} · ${j.done}/${j.total} · ${j.failed} erros · ${esc(j.message || '')}</div></div>
      <div class="toolbar"><label class="inline"><input type="checkbox" id="only-err"> só erros</label></div></div>
      <div class="log" id="log"></div>`;
    const render = (onlyErr) =>
      ($('#log').innerHTML = (j.log || []).filter((l) => !onlyErr || !l.ok).map((l) => `<div class="${l.ok ? '' : 'bad'}">${l.ok ? '✓' : '✗'} ${esc(l.msg)}</div>`).join('') || '<span class="muted">Sem registros.</span>');
    render(false);
    $('#only-err').onchange = (e) => render(e.target.checked);
    if (j.status === 'running') setTimeout(() => location.hash === `#/tarefas/${id}` && refresh(), 1500);
    return;
  }
  const jobs = await api('GET', '/jobs');
  view.innerHTML = `<div class="page-head"><div><h1>Tarefas</h1><div class="muted">Histórico de sincronizações e inclusões</div></div></div>
    ${
      jobs.length
        ? `<div class="table-wrap"><table><thead><tr><th>Tarefa</th><th>Status</th><th class="num">Progresso</th><th class="num">Erros</th><th>Início</th><th>Mensagem</th></tr></thead><tbody>
      ${jobs.map((j) => `<tr class="clickable" onclick="location.hash='#/tarefas/${j.id}'"><td>${esc(j.title)}</td><td>${jobBadge(j.status)}</td><td class="num">${j.done}/${j.total}</td><td class="num ${j.failed ? 'neg' : ''}">${j.failed}</td><td class="small nowrap">${date(j.created_at?.includes('T') ? j.created_at : j.created_at + 'Z')}</td><td class="small">${esc(j.message || '')}</td></tr>`).join('')}
      </tbody></table></div>`
        : '<div class="card empty">Nenhuma tarefa ainda.</div>'
    }`;
};
const jobBadge = (s) =>
  ({ running: '<span class="badge info">em andamento</span>', done: '<span class="badge ok">concluída</span>', done_with_errors: '<span class="badge warn">com erros</span>', error: '<span class="badge bad">falhou</span>', interrupted: '<span class="badge neutral">interrompida</span>' })[s] || esc(s);

// ---------- Início ----------
guard(loadStatus).then(router);
