// Cálculo de lucro, margem e preço mínimo viável de um anúncio.
//
// Lucro = preço recebido - comissão ML - custo fixo ML - frete pago pelo vendedor - impostos - custo dos produtos
// Viável quando lucro >= lucro mínimo E margem (lucro / preço) >= margem mínima.

const EPS = 1e-9;

export const round2 = (v) => Math.round((v + Number.EPSILON) * 100) / 100;
export const ceil2 = (v) => Math.ceil(round2(v * 100) - EPS) / 100;
export const floor2 = (v) => Math.floor(round2(v * 100) + EPS) / 100;

/**
 * Monta o contexto de custos de um anúncio.
 * row: linha com cost, min_profit, min_margin_percent, fee_percent, free_shipping, shipping_cost, shipping_cost_override
 */
export function buildContext(row, settings) {
  const linked = row.cost !== null && row.cost !== undefined;
  const override = row.shipping_cost_override;
  let shipping = 0;
  let shippingForced = false;
  if (override !== null && override !== undefined) {
    shipping = override;
    shippingForced = true;
  } else if (row.free_shipping) {
    shipping = row.shipping_cost ?? settings.default_shipping_cost ?? 0;
  }
  return {
    linked,
    cost: linked ? row.cost : 0,
    feePercent: row.fee_percent_override ?? row.fee_percent ?? settings.default_fee_percent,
    taxPercent: settings.tax_percent || 0,
    shipping,
    // Com valor definido manualmente, o frete é sempre considerado; caso contrário segue a regra do limite de frete grátis
    freeShippingThreshold: shippingForced ? null : settings.free_shipping_threshold || null,
    fixedFeeBands: [...(settings.fixed_fee_bands || [])].sort((a, b) => a.up_to - b.up_to),
    minProfit: row.min_profit ?? settings.default_min_profit ?? 0,
    minMarginPercent: row.min_margin_percent ?? settings.default_min_margin_percent ?? 0,
  };
}

export function fixedFee(price, bands) {
  for (const b of bands) if (price < b.up_to) return b.fee;
  return 0;
}

export function shippingAt(price, ctx) {
  if (ctx.freeShippingThreshold && price < ctx.freeShippingThreshold) return 0;
  return ctx.shipping;
}

/**
 * Lucro em um preço de venda.
 * @param price preço pago pelo comprador (base da comissão)
 * @param received quanto o vendedor efetivamente recebe antes das tarifas (difere em campanhas co-participadas)
 */
export function profitAt(price, ctx, received = price) {
  const fee = (price * ctx.feePercent) / 100 + fixedFee(price, ctx.fixedFeeBands);
  const ship = shippingAt(price, ctx);
  const tax = (received * ctx.taxPercent) / 100;
  const profit = received - fee - ship - tax - ctx.cost;
  return {
    profit: round2(profit),
    margin: received > 0 ? round2((profit / received) * 100) : 0,
    fee: round2(fee),
    shipping: round2(ship),
    tax: round2(tax),
  };
}

export function isViable(result, ctx) {
  return result.profit + EPS >= ctx.minProfit && result.margin + EPS >= ctx.minMarginPercent;
}

/**
 * Menor preço (em centavos) que ainda atende lucro e margem mínimos.
 * A função de lucro é linear por partes (faixas de custo fixo e limite do frete grátis),
 * então resolvemos analiticamente em cada intervalo, do mais barato ao mais caro.
 * Retorna null se nenhum preço é viável.
 */
export function minViablePrice(ctx) {
  if (!ctx.linked) return null;
  const points = new Set([0]);
  for (const b of ctx.fixedFeeBands) points.add(b.up_to);
  if (ctx.freeShippingThreshold) points.add(ctx.freeShippingThreshold);
  const sorted = [...points].sort((a, b) => a - b);
  sorted.push(Infinity);

  const f = ctx.feePercent / 100;
  const t = ctx.taxPercent / 100;
  const m = ctx.minMarginPercent / 100;

  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    const sample = b === Infinity ? a + 1 : (a + b) / 2;
    const K = ctx.cost + shippingAt(sample, ctx) + fixedFee(sample, ctx.fixedFeeBands);
    const d1 = 1 - f - t;
    const d2 = 1 - f - t - m;
    if (d1 <= 1e-6 || d2 <= 1e-6) return null;
    const required = Math.max((K + ctx.minProfit) / d1, K / d2, 0.01);
    let candidate = ceil2(Math.max(a, required));
    if (candidate >= b) continue;
    // Ajuste fino por arredondamento de centavos
    for (let k = 0; k < 3 && !isViable(profitAt(candidate, ctx), ctx); k++) candidate = round2(candidate + 0.01);
    if (candidate < b && isViable(profitAt(candidate, ctx), ctx)) return candidate;
  }
  return null;
}

export function discountPercent(original, price) {
  if (!original || original <= 0) return 0;
  return round2((1 - price / original) * 100);
}
