import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildContext, profitAt, minViablePrice, isViable } from '../src/services/pricing.js';
import { DEFAULT_SETTINGS } from '../src/db.js';

const settings = { ...DEFAULT_SETTINGS, tax_percent: 6, default_min_margin_percent: 10, default_min_profit: 0 };

test('lucro considera comissão, custo fixo, frete e impostos', () => {
  const ctx = buildContext({ cost: 50, fee_percent: 12, free_shipping: 1, shipping_cost: 20 }, settings);
  const r = profitAt(100, ctx);
  // 100 - 12 (comissão) - 20 (frete) - 6 (imposto) - 50 (custo) = 12
  assert.equal(r.profit, 12);
  assert.equal(r.margin, 12);
});

test('abaixo do limite de frete grátis o vendedor paga custo fixo e não paga frete', () => {
  const ctx = buildContext({ cost: 20, fee_percent: 12, free_shipping: 1, shipping_cost: 20 }, settings);
  const r = profitAt(60, ctx);
  assert.equal(r.shipping, 0);
  assert.equal(r.fee, 7.2 + 6.75);
});

test('preço mínimo viável é o menor preço que atende a margem', () => {
  const ctx = buildContext({ cost: 50, fee_percent: 12, free_shipping: 1, shipping_cost: 20 }, settings);
  const p = minViablePrice(ctx);
  assert.ok(isViable(profitAt(p, ctx), ctx), 'preço encontrado é viável');
  assert.ok(!isViable(profitAt(p - 0.01, ctx), ctx), 'um centavo abaixo não é viável');
  // Com frete (>=79): p*(1-0.12-0.06-0.10) >= 70 → p >= 97.23; abaixo de 79 sem frete: p*0.72 >= 56.75 → 78.82 (< 79, viável!)
  assert.equal(p, 78.82);
});

test('lucro mínimo em reais por anúncio', () => {
  const ctx = buildContext({ cost: 100, fee_percent: 10, min_profit: 30, min_margin_percent: 0, free_shipping: 0 }, { ...settings, tax_percent: 0 });
  // p*0.9 - 100 >= 30 → p >= 144.45
  assert.equal(minViablePrice(ctx), 144.45);
});

test('sem vínculo não há preço viável', () => {
  assert.equal(minViablePrice(buildContext({ cost: null }, settings)), null);
});

test('custo que nunca fecha retorna null', () => {
  const ctx = buildContext({ cost: 10, fee_percent: 60, free_shipping: 0 }, { ...settings, tax_percent: 30 });
  assert.equal(minViablePrice(ctx), null);
});
