'use strict';
// Money is stored as numeric(14,2) and handed to the app as plain numbers
// (lib/tenant.js). These tests fail if a money column goes back to Float, or if
// a Decimal object ever leaks out of Prisma.
const test = require('node:test');
const assert = require('node:assert');
const { Prisma } = require('@prisma/client');
const { db, tenantDb, decimalsToNumbers } = require('../lib/tenant');
const { signupChurch } = require('../lib/provision');
const ledger = require('../lib/ledger-pg');

const createdChurchIds = [];

test.after(async () => {
  if (createdChurchIds.length) {
    const where = { churchId: { in: createdChurchIds } };
    await db.journalLine.deleteMany({ where });
    await db.journalEntry.deleteMany({ where });
    await db.financialPeriod.deleteMany({ where });
    await db.expense.deleteMany({ where });
    await db.fund.deleteMany({ where });
    await db.account.deleteMany({ where });
    await db.user.deleteMany({ where });
    await db.specialCategory.deleteMany({ where });
    await db.serviceType.deleteMany({ where });
    await db.expenseCategory.deleteMany({ where });
    await db.church.deleteMany({ where: { id: { in: createdChurchIds } } });
  }
  await db.$disconnect();
});

async function newChurch(tag) {
  const email = `${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const { church, user } = await signupChurch({ churchName: `${tag} Church`, name: 'Owner', email, password: 'Tr0ubadour-7!' });
  createdChurchIds.push(church.id);
  return { churchId: church.id, user };
}

test('decimalsToNumbers converts nested Decimals and leaves everything else alone', () => {
  const D = Prisma.Decimal;
  const when = new Date('2026-01-01');
  const out = decimalsToNumbers({ a: new D('12.50'), rows: [new D('0.10'), { x: new D('3') }], when, s: 'text', z: null });
  assert.strictEqual(out.a, 12.5);
  assert.strictEqual(out.rows[0], 0.1);
  assert.strictEqual(out.rows[1].x, 3);
  assert.strictEqual(out.when, when);
  assert.strictEqual(out.z, null);
});

test('ten postings of 0.10 sum to exactly 1.00 in SQL (a double would give 0.9999999999999999)', async () => {
  const { churchId } = await newChurch('dec-exact');
  const scoped = tenantDb(churchId);
  for (let i = 0; i < 10; i++) {
    await ledger.postCashIncome(scoped, churchId, { date: '2026-06-01', amount: 0.1, category: 'Tithe', sourceType: 'GENERIC_INCOME', sourceId: i + 1 });
  }
  const [row] = await db.$queryRaw`
    SELECT SUM(jl.debit)::text AS debit_text, SUM(jl.credit)::text AS credit_text
    FROM journal_lines jl WHERE jl.church_id = ${churchId}`;
  assert.strictEqual(row.debit_text, '1.00');
  assert.strictEqual(row.credit_text, '1.00');
  assert.strictEqual(await ledger.assetBalance(scoped, churchId, ledger.ACC.CASH), 1);
});

test('0.1 + 0.2 posts as an exactly balanced 0.30 entry', async () => {
  const { churchId } = await newChurch('dec-sum');
  const scoped = tenantDb(churchId);
  const entryId = await ledger.postCashIncome(scoped, churchId, { date: '2026-06-02', amount: 0.1 + 0.2, category: 'Tithe', sourceType: 'GENERIC_INCOME', sourceId: 1 });
  const lines = await scoped.journalLine.findMany({ where: { entryId } });
  assert.deepStrictEqual(lines.map((l) => [l.debit, l.credit]).sort(), [[0, 0.3], [0.3, 0]].sort());
});

test('Decimals never leak: model reads, aggregates, groupBy and raw SQL all give numbers', async () => {
  const { churchId, user } = await newChurch('dec-types');
  const scoped = tenantDb(churchId);
  const fund = await scoped.fund.create({ data: { name: 'General', fundType: 'GENERAL', code: 'GEN', openingBalance: 12.5 } });
  await scoped.expense.create({ data: { category: 'Utilities', amount: 19.99, spentOn: new Date('2026-06-02'), fundId: fund.id, recordedBy: user.id } });

  assert.strictEqual(typeof (await scoped.fund.findUnique({ where: { id: fund.id } })).openingBalance, 'number');
  assert.strictEqual(typeof (await scoped.expense.findFirst()).amount, 'number');
  assert.strictEqual((await scoped.expense.aggregate({ _sum: { amount: true } }))._sum.amount, 19.99);
  const grouped = await scoped.expense.groupBy({ by: ['category'], _sum: { amount: true } });
  assert.strictEqual(typeof grouped[0]._sum.amount, 'number');

  const [viaScoped] = await scoped.$queryRaw`SELECT 1.5::numeric AS x`;
  const [viaRaw] = await db.$queryRaw`SELECT 1.5::numeric AS x`;
  assert.strictEqual(viaScoped.x, 1.5);
  assert.strictEqual(viaRaw.x, 1.5);

  const nested = await scoped.fund.findUnique({ where: { id: fund.id }, include: { expenses: true } });
  assert.strictEqual(typeof nested.expenses[0].amount, 'number');
});

test('amounts are stored to the pesewa and oversized amounts are refused by validation', async () => {
  const { churchId, user } = await newChurch('dec-round');
  const scoped = tenantDb(churchId);
  const fund = await scoped.fund.create({ data: { name: 'General', fundType: 'GENERAL', code: 'GEN' } });
  const e = await scoped.expense.create({ data: { category: 'Utilities', amount: 10.006, spentOn: new Date('2026-06-02'), fundId: fund.id, recordedBy: user.id } });
  assert.strictEqual(e.amount, 10.01, 'stored rounded to 2 decimals');

  const { isMoneyPositive, isMoneyNonNeg } = require('../lib/format');
  assert.ok(isMoneyPositive(999999999999.99));
  assert.ok(!isMoneyPositive(1e12));
  assert.ok(!isMoneyNonNeg(1e15));
});
