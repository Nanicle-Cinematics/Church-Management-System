'use strict';
// Cash count arithmetic. Pure (no database), shared by the count route and
// the printed sheet, and tested on its own (test/cash-count.test.js).
//
// Everything is counted in PESEWAS (integers). 0.1 + 0.2 is not 0.3 in
// floating point, and a count sheet that is out by a pesewa because of the
// computer rather than the counters would undermine the one thing it is for.

// Bank of Ghana notes and coins in circulation. GH₵2 and GH₵1 exist as both
// a note and a coin, so each is counted on its own line.
const NOTES = [200, 100, 50, 20, 10, 5, 2, 1];
const COINS = [2, 1, 0.5, 0.2, 0.1, 0.05, 0.01];

function pesewaLabel(value) {
  const p = Math.round(value * 100);
  return `${p} pesewa${p === 1 ? '' : 's'}`;
}

function denominationLabel(kind, value) {
  if (value < 1) return pesewaLabel(value);
  return `GH₵ ${value} ${kind === 'COIN' ? 'coin' : 'note'}`;
}

const DENOMINATIONS = [
  ...NOTES.map((value) => ({ key: `NOTE-${value}`, kind: 'NOTE', value, label: denominationLabel('NOTE', value) })),
  ...COINS.map((value) => ({ key: `COIN-${value}`, kind: 'COIN', value, label: denominationLabel('COIN', value) })),
];
const BY_KEY = new Map(DENOMINATIONS.map((d) => [d.key, d]));
const ORDER = new Map(DENOMINATIONS.map((d, i) => [d.key, i]));

const toPesewas = (cedis) => Math.round(Number(cedis) * 100);
const fromPesewas = (pesewas) => pesewas / 100;

/**
 * Turn the quantities typed against each denomination (keyed "NOTE-50",
 * "COIN-0.5", ...) into count lines and a total. Blank or zero quantities
 * are dropped; anything that is not a whole, non-negative number of notes or
 * coins is refused rather than rounded, since "3.5 fifty-cedi notes" is a
 * typing error, not a count.
 */
function computeCount(quantities) {
  const lines = [];
  let totalPesewas = 0;
  for (const [key, raw] of Object.entries(quantities || {})) {
    const denom = BY_KEY.get(key);
    if (!denom) continue;
    const text = String(raw == null ? '' : raw).trim();
    if (text === '') continue;
    const quantity = Number(text);
    if (!Number.isInteger(quantity) || quantity < 0) {
      return { ok: false, message: `The quantity for ${denom.label} must be a whole number (got "${text}").` };
    }
    if (quantity === 0) continue;
    const amountPesewas = toPesewas(denom.value) * quantity;
    totalPesewas += amountPesewas;
    lines.push({ key, kind: denom.kind, value: denom.value, quantity, amount: fromPesewas(amountPesewas) });
  }
  if (!lines.length) return { ok: false, message: 'Enter how many of at least one note or coin were counted.' };
  lines.sort((a, b) => ORDER.get(a.key) - ORDER.get(b.key));
  return { ok: true, lines, total: fromPesewas(totalPesewas) };
}

/** Counted minus expected, in GH₵, and what that difference means. */
function countVariance(counted, expected) {
  if (expected === null || expected === undefined || expected === '') return { kind: 'NONE' };
  const diff = toPesewas(counted) - toPesewas(expected);
  if (diff === 0) return { kind: 'BALANCED', difference: 0 };
  return { kind: diff < 0 ? 'SHORTAGE' : 'SURPLUS', difference: fromPesewas(diff) };
}

/** Sum GH₵ amounts exactly, via pesewas. */
function sumMoney(amounts) {
  return fromPesewas(amounts.reduce((s, a) => s + toPesewas(a || 0), 0));
}

module.exports = {
  DENOMINATIONS, computeCount, countVariance, denominationLabel, pesewaLabel, toPesewas, fromPesewas, sumMoney,
};
