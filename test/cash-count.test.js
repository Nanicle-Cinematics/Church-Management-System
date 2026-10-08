'use strict';
// Cash count arithmetic (lib/cash-count.js). No database.
const test = require('node:test');
const assert = require('node:assert');
const { DENOMINATIONS, computeCount, countVariance, denominationLabel, sumMoney } = require('../lib/cash-count');

test('every Bank of Ghana note and coin is offered, GH₵2 and GH₵1 as both', () => {
  assert.strictEqual(DENOMINATIONS.filter((d) => d.kind === 'NOTE').length, 8);
  assert.strictEqual(DENOMINATIONS.filter((d) => d.kind === 'COIN').length, 7);
  const r = computeCount({ 'NOTE-2': '1', 'COIN-2': '1' });
  assert.ok(r.ok);
  assert.strictEqual(r.lines.length, 2);
  assert.strictEqual(r.total, 4);
});

test('totals are exact in pesewas, not floating point', () => {
  // 0.1 + 0.2 trap: three 10p and three 20p coins are exactly GH₵ 0.90
  assert.strictEqual(computeCount({ 'COIN-0.1': '3', 'COIN-0.2': '3' }).total, 0.9);
  assert.strictEqual(computeCount({ 'COIN-0.01': '7', 'COIN-0.05': '3', 'COIN-0.5': '1' }).total, 0.72);
  assert.strictEqual(computeCount({ 'NOTE-200': '4', 'NOTE-100': '3', 'NOTE-50': '4', 'NOTE-20': '5', 'NOTE-10': '3', 'NOTE-5': '4' }).total, 1450);
  assert.strictEqual(sumMoney([0.1, 0.2]), 0.3);
});

test('a count that is not whole notes and coins is refused, not rounded', () => {
  assert.strictEqual(computeCount({ 'NOTE-50': '3.5' }).ok, false);
  assert.strictEqual(computeCount({ 'NOTE-50': '-1' }).ok, false);
  assert.strictEqual(computeCount({ 'NOTE-50': 'abc' }).ok, false);
  assert.strictEqual(computeCount({ 'NOTE-50': '', 'NOTE-20': '0' }).ok, false, 'nothing counted');
});

test('unknown denominations are ignored and lines print notes then coins, high to low', () => {
  const r = computeCount({ 'COIN-1': '1', 'NOTE-7': '9', 'NOTE-1': '1', 'NOTE-200': '1' });
  assert.ok(r.ok);
  assert.deepStrictEqual(r.lines.map((l) => l.key), ['NOTE-200', 'NOTE-1', 'COIN-1']);
  assert.strictEqual(r.total, 202);
});

test('variance: none, balanced, shortage and surplus', () => {
  assert.strictEqual(countVariance(100, null).kind, 'NONE');
  assert.strictEqual(countVariance(100, '').kind, 'NONE');
  assert.strictEqual(countVariance(1450, 1450).kind, 'BALANCED');
  assert.strictEqual(countVariance(0.3, 0.1 + 0.2).kind, 'BALANCED', 'not a floating-point shortage');
  assert.deepStrictEqual(countVariance(1195, 1200), { kind: 'SHORTAGE', difference: -5 });
  assert.deepStrictEqual(countVariance(1200.5, 1200), { kind: 'SURPLUS', difference: 0.5 });
});

test('labels read naturally', () => {
  assert.strictEqual(denominationLabel('NOTE', 50), 'GH₵ 50 note');
  assert.strictEqual(denominationLabel('COIN', 2), 'GH₵ 2 coin');
  assert.strictEqual(denominationLabel('COIN', 0.5), '50 pesewas');
  assert.strictEqual(denominationLabel('COIN', 0.01), '1 pesewa');
});
