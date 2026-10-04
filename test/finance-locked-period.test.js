'use strict';
// Recording into a LOCKED financial period must be refused cleanly: every
// recording route creates its record and then posts to the ledger, and the
// ledger throws on a locked period. Without a guard the record is left behind
// with no journal entry (and the user sees a 500).
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { createTenantApp } = require('../lib/tenant-http');
const { db, tenantDb } = require('../lib/tenant');
const ledger = require('../lib/ledger-pg');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const createdChurchIds = [];

let server, base;
test.before(async () => {
  const app = createTenantApp({ pool });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  server.close();
  if (createdChurchIds.length) {
    const where = { churchId: { in: createdChurchIds } };
    await db.pledgePayment.deleteMany({ where: { pledge: { churchId: { in: createdChurchIds } } } });
    await db.dayBornSplit.deleteMany({ where: { OR: [{ service: { churchId: { in: createdChurchIds } } }, { harvest: { churchId: { in: createdChurchIds } } }] } });
    await db.pledge.deleteMany({ where });
    await db.harvest.deleteMany({ where });
    await db.service.deleteMany({ where });
    await db.tithe.deleteMany({ where });
    await db.specialOffering.deleteMany({ where });
    await db.dayBornCollection.deleteMany({ where });
    await db.member.deleteMany({ where });
    await db.financialPeriod.deleteMany({ where });
    await db.activityLog.deleteMany({ where });
    await db.paymentVoucher.deleteMany({ where });
    await db.financeSetting.deleteMany({ where });
    await db.financeBudgetLine.deleteMany({ where });
    await db.financeBudget.deleteMany({ where });
    await db.financeReceipt.deleteMany({ where });
    await db.expense.deleteMany({ where });
    await db.incomeRecord.deleteMany({ where });
    await db.financeProject.deleteMany({ where });
    await db.expenseCategory.deleteMany({ where });
    await db.specialCategory.deleteMany({ where });
    await db.serviceType.deleteMany({ where });
    await db.journalLine.deleteMany({ where });
    await db.journalEntry.deleteMany({ where });
    await db.financialPeriod.deleteMany({ where });
    await db.fund.deleteMany({ where });
    await db.account.deleteMany({ where });
    await db.user.deleteMany({ where });
    await db.church.deleteMany({ where: { id: { in: createdChurchIds } } });
  }
  await db.$disconnect();
  await pool.end();
});

function client() {
  let cookie;
  const remember = (res) => {
    const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of set) if (c.startsWith('connect.sid=')) cookie = c.split(';')[0];
  };
  return {
    async postJson(p, jsonBody) {
      const res = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(jsonBody) });
      remember(res);
      return { status: res.status, body: await res.json() };
    },
    async getHtml(p) {
      const res = await fetch(base + p, { headers: cookie ? { cookie } : {}, redirect: 'manual' });
      remember(res);
      return { status: res.status, text: res.status < 300 ? await res.text() : '' };
    },
    async getCsv(p) {
      const res = await fetch(base + p, { headers: cookie ? { cookie } : {} });
      remember(res);
      return { status: res.status, text: await res.text() };
    },
    async postForm(p, form) {
      const res = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(form).toString(), redirect: 'manual' });
      remember(res);
      return { status: res.status, location: res.headers.get('location') };
    },
  };
}
function uniqueEmail(tag) {
  return `${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
}
async function signedInChurch(tag) {
  const c = client();
  const signup = await c.postJson('/signup', { churchName: `${tag} Church`, name: 'Admin Person', email: uniqueEmail(tag), password: 'password123' });
  assert.strictEqual(signup.status, 201);
  createdChurchIds.push(signup.body.church.id);
  return { client: c, churchId: signup.body.church.id };
}
function csrfOf(html) {
  const m = html.match(/name="_csrf" value="([^"]*)"/);
  return m ? m[1] : null;
}
// Expenses are SUBMITTED on creation and only posted to the ledger once a
// fund manager other than the recorder approves them — every test below
// that needs a PAID expense (voucher issued, project "spent", budget
// actuals) has to go through this second-user approval step.
async function approveExpense(churchId, expenseId) {
  const email = uniqueEmail('approver');
  const passwordHash = await bcrypt.hash('password123', 10);
  await db.user.create({ data: { churchId, username: `approver-${Date.now()}`, email, passwordHash, role: 'VIEWER', financeRole: 'TREASURER' } });
  const approver = client();
  const login = await approver.postJson('/login', { email, password: 'password123' });
  assert.strictEqual(login.status, 200);
  const page = await approver.getHtml('/finance/expenses');
  const csrf = csrfOf(page.text);
  const approved = await approver.postForm(`/finance/expenses/${expenseId}/approve`, { _csrf: csrf });
  assert.strictEqual(approved.status, 302);
}



async function csrfFrom(c, path) { return csrfOf((await c.getHtml(path)).text); }

test('recording into a locked period is refused and leaves no orphaned rows', async () => {
  const { client: c, churchId } = await signedInChurch('locked-period');
  const fund = await db.fund.create({ data: { churchId, name: 'General', fundType: 'GENERAL', code: 'GEN' } });
  const member = await db.member.create({ data: { churchId, firstName: 'Ama', lastName: 'Owusu' } });
  const special = await db.specialCategory.findFirst({ where: { churchId } });
  const serviceType = await db.serviceType.findFirst({ where: { churchId } });
  await db.financialPeriod.create({ data: { churchId, year: 2026, month: 6, status: 'LOCKED', closedAt: new Date() } });

  const cases = [
    ['/finance/income', '/finance/income', { transactionDate: '2026-06-10', category: 'donation', amount: '100', fundId: String(fund.id) }, () => db.incomeRecord.count({ where: { churchId } })],
    ['/finance/tithes', '/finance/tithes', { memberId: String(member.id), titheDate: '2026-06-10', amount: '50' }, () => db.tithe.count({ where: { churchId } })],
    ['/finance/special', '/finance/special', { specialCatId: String(special.id), offeringDate: '2026-06-10', amount: '75' }, () => db.specialOffering.count({ where: { churchId } })],
    ['/finance/day-borns', '/finance/day-borns', { collectionDate: '2026-06-10', dayBorn: 'SUNDAY', amount: '40', fundId: String(fund.id) }, () => db.dayBornCollection.count({ where: { churchId } })],
    ['/finance/services', '/finance/services', { serviceTypeId: String(serviceType.id), serviceDate: '2026-06-10', totalAmount: '200' }, () => db.service.count({ where: { churchId } })],
    ['/finance/harvests', '/finance/harvests', { harvestType: 'OTHER', harvestYear: '2026', harvestName: 'June harvest', harvestDate: '2026-06-10', totalCollected: '300' }, () => db.harvest.count({ where: { churchId } })],
  ];
  for (const [label, page, form, count] of cases) {
    const csrf = await csrfFrom(c, page);
    const r = await c.postForm(label, { ...form, _csrf: csrf });
    assert.strictEqual(r.status, 302, `${label}: expected a redirect, got ${r.status}`);
    assert.strictEqual(await count(), 0, `${label}: left an orphaned record behind`);
  }
  assert.strictEqual(await db.journalEntry.count({ where: { churchId } }), 0, 'nothing may be posted to a locked period');
});

test('the same forms still record normally in an open period', async () => {
  const { client: c, churchId } = await signedInChurch('open-period');
  const fund = await db.fund.create({ data: { churchId, name: 'General', fundType: 'GENERAL', code: 'GEN' } });
  const csrf = await csrfFrom(c, '/finance/income');
  const r = await c.postForm('/finance/income', { transactionDate: '2026-07-10', category: 'donation', amount: '100', fundId: String(fund.id), _csrf: csrf });
  assert.strictEqual(r.status, 302);
  assert.strictEqual(await db.incomeRecord.count({ where: { churchId } }), 1);
  assert.strictEqual(await db.journalEntry.count({ where: { churchId } }), 1);
});

test('a pledge payment into a locked period does not mark the pledge paid', async () => {
  const { client: c, churchId } = await signedInChurch('locked-pledge');
  const member = await db.member.create({ data: { churchId, firstName: 'Kojo', lastName: 'Boateng' } });
  const harvest = await db.harvest.create({ data: { churchId, harvestType: 'OTHER', harvestYear: 2026, harvestName: 'Harvest' } });
  const pledge = await db.pledge.create({ data: { churchId, memberId: member.id, harvestId: harvest.id, pledgedAmount: 500, paidAmount: 0, pledgeDate: new Date('2026-01-15') } });
  const now = new Date();
  await db.financialPeriod.create({ data: { churchId, year: now.getUTCFullYear(), month: now.getUTCMonth() + 1, status: 'LOCKED', closedAt: now } });

  const csrf = await csrfFrom(c, '/finance/pledges');
  const r = await c.postForm(`/finance/pledges/${pledge.id}/pay`, { add: '100', _csrf: csrf });
  assert.strictEqual(r.status, 302);
  const after = await db.pledge.findUnique({ where: { id: pledge.id } });
  assert.strictEqual(after.paidAmount, 0, 'pledge must not be credited when the ledger cannot take the payment');
  assert.strictEqual(await db.pledgePayment.count({ where: { pledge: { churchId } } }), 0);
});

test('expense approval into a locked period is refused and the expense stays submitted', async () => {
  const { churchId } = await signedInChurch('locked-expense');
  const admin = await db.user.findFirst({ where: { churchId } });
  const fund = await db.fund.create({ data: { churchId, name: 'General', fundType: 'GENERAL', code: 'GEN' } });
  const cat = await db.expenseCategory.findFirst({ where: { churchId, categoryName: 'Utilities' } });
  const e = await db.expense.create({ data: { churchId, expenseCatId: cat.id, category: 'Utilities', amount: 90, spentOn: new Date('2026-06-05'), description: 'June bill', fundId: fund.id, approvalStatus: 'SUBMITTED', submittedAt: new Date(), recordedBy: admin.id } });
  await db.financialPeriod.create({ data: { churchId, year: 2026, month: 6, status: 'LOCKED', closedAt: new Date() } });
  const email = uniqueEmail('lk-approver');
  await db.user.create({ data: { churchId, username: `lk-${Date.now()}`, email, passwordHash: await bcrypt.hash('password123', 10), role: 'VIEWER', financeRole: 'TREASURER' } });
  const approver = client();
  await approver.postJson('/login', { email, password: 'password123' });
  const csrf = await csrfFrom(approver, '/finance/expenses');
  const r = await approver.postForm(`/finance/expenses/${e.id}/approve`, { _csrf: csrf });
  assert.strictEqual(r.status, 302);
  assert.strictEqual((await db.expense.findUnique({ where: { id: e.id } })).approvalStatus, 'SUBMITTED');
});

test('JSON API refuses a locked period with 409 and creates nothing', async () => {
  const { client: c, churchId } = await signedInChurch('locked-json');
  const fund = await db.fund.create({ data: { churchId, name: 'General', fundType: 'GENERAL', code: 'GEN' } });
  await db.financialPeriod.create({ data: { churchId, year: 2026, month: 6, status: 'LOCKED', closedAt: new Date() } });
  const r = await c.postJson('/api/finance/income', { transactionDate: '2026-06-10', category: 'donation', amount: 100, fundId: fund.id });
  assert.strictEqual(r.status, 409);
  assert.match(r.body.error, /locked/);
  assert.strictEqual(await db.incomeRecord.count({ where: { churchId } }), 0);
  const ok = await c.postJson('/api/finance/income', { transactionDate: '2026-07-10', category: 'donation', amount: 100, fundId: fund.id });
  assert.strictEqual(ok.status, 201, 'an open period still records');
});
