import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, parseNum, resolveSku } from '../src/services/catalog.js';

test('parseNum aceita formato brasileiro', () => {
  assert.equal(parseNum('1.234,56'), 1234.56);
  assert.equal(parseNum('R$ 12,5'), 12.5);
  assert.equal(parseNum('1,234.56'), 1234.56);
  assert.equal(parseNum(''), null);
});

test('parseCsv detecta ; e normaliza cabeçalhos', () => {
  const rows = parseCsv('SKU;Nome;Custo;Margem mínima\nA1;"Produto; A";10,50;15\n');
  assert.deepEqual(rows, [{ sku: 'A1', nome: 'Produto; A', custo: '10,50', margem_minima: '15' }]);
});

test('resolveSku entende kits e composições', () => {
  const products = { ABC: { id: 1 }, DEF: { id: 2 } };
  const find = (s) => products[s.toUpperCase()];
  assert.deepEqual(resolveSku('ABC', find), [{ product_id: 1, quantity: 1 }]);
  assert.deepEqual(resolveSku('ABC-KIT3', find), [{ product_id: 1, quantity: 3 }]);
  assert.deepEqual(resolveSku('ABC+DEF', find), [{ product_id: 1, quantity: 1 }, { product_id: 2, quantity: 1 }]);
  assert.deepEqual(resolveSku('ABC+ABC', find), [{ product_id: 1, quantity: 2 }]);
  assert.deepEqual(resolveSku('ABC,ABC', find), [{ product_id: 1, quantity: 1 }]);
  assert.equal(resolveSku('ABC,DEF', find), null);
  assert.equal(resolveSku('ZZZ', find), null);
});
