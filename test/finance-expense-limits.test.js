'use strict';
// Expense approval tiers: who may approve an expense depends on its amount
// versus FinanceSetting.smallExpenseMax / mediumExpenseMax.
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
  const signup = await c.postJson('/signup', { churchName: `${tag} Church`, name: 'Admin Person', email: uniqueEmail(tag), password: 'Tr0ubadour-7!' });
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
  const passwordHash = await bcrypt.hash('Tr0ubadour-7!', 10);
  await db.user.create({ data: { churchId, username: `approver-${Date.now()}`, email, passwordHash, role: 'VIEWER', financeRole: 'TREASURER' } });
  const approver = client();
  const login = await approver.postJson('/login', { email, password: 'Tr0ubadour-7!' });
  assert.strictEqual(login.status, 200);
  const page = await approver.getHtml('/finance/expenses');
  const csrf = csrfOf(page.text);
  const approved = await approver.postForm(`/finance/expenses/${expenseId}/approve`, { _csrf: csrf });
  assert.strictEqual(approved.status, 302);
}


const { approverTier, requiredTier, checkApprovalTier } = require('../lib/expense-approval');

test('unit: tier boundaries use <= on the limits and fall back to defaults', () => {
  const s = { smallExpenseMax: 500, mediumExpenseMax: 5000 };
  assert.strictEqual(requiredTier(0.01, s), 1);
  assert.strictEqual(requiredTier(500, s), 1, 'exactly the small limit is still tier 1');
  assert.strictEqual(requiredTier(500.01, s), 2);
  assert.strictEqual(requiredTier(5000, s), 2, 'exactly the medium limit is still tier 2');
  assert.strictEqual(requiredTier(5000.01, s), 3);
  assert.strictEqual(requiredTier(600, null), 2, 'no settings row uses the 500 / 5000 defaults');
  assert.strictEqual(requiredTier(6000, undefined), 3);
});

test('unit: approver tiers and who passes which gate', () => {
  const admin = { role: 'ADMIN', financeRole: 'NONE' };
  const finAdmin = { role: 'VIEWER', financeRole: 'FINANCE_ADMIN' };
  const treasurer = { role: 'VIEWER', financeRole: 'TREASURER' };
  const cashier = { role: 'VIEWER', financeRole: 'CASHIER' };
  assert.deepStrictEqual([admin, finAdmin, treasurer, cashier, null].map(approverTier), [3, 2, 1, 0, 0]);
  const s = { smallExpenseMax: 500, mediumExpenseMax: 5000 };
  assert.ok(checkApprovalTier(treasurer, 500, s).ok);
  assert.deepStrictEqual(checkApprovalTier(treasurer, 501, s), { ok: false, needs: 'a Finance Admin or Admin' });
  assert.ok(checkApprovalTier(finAdmin, 5000, s).ok);
  assert.deepStrictEqual(checkApprovalTier(finAdmin, 5001, s), { ok: false, needs: 'an Admin' });
  assert.ok(checkApprovalTier(admin, 1e9, s).ok);
  assert.strictEqual(checkApprovalTier(cashier, 1, s).ok, false);
});

async function userWithRole(churchId, tag, financeRole, role = 'VIEWER') {
  const email = uniqueEmail(tag);
  const user = await db.user.create({ data: { churchId, username: `${tag}-${Date.now()}`, email, passwordHash: await bcrypt.hash('Tr0ubadour-7!', 10), role, financeRole } });
  const c = client();
  assert.strictEqual((await c.postJson('/login', { email, password: 'Tr0ubadour-7!' })).status, 200);
  return { client: c, user };
}
async function recordExpense(churchId, amount, recordedBy) {
  const fund = (await db.fund.findFirst({ where: { churchId } })) || await db.fund.create({ data: { churchId, name: 'General', fundType: 'GENERAL', code: 'GEN' } });
  const cat = await db.expenseCategory.findFirst({ where: { churchId, categoryName: 'Utilities' } });
  return db.expense.create({ data: { churchId, expenseCatId: cat.id, category: 'Utilities', amount, spentOn: new Date('2026-06-01'), description: `Expense ${amount}`, fundId: fund.id, approvalStatus: 'SUBMITTED', submittedAt: new Date(), recordedBy } });
}
async function approveVia(actor, id) {
  const csrf = csrfOf((await actor.getHtml('/finance/expenses')).text);
  await actor.postForm(`/finance/expenses/${id}/approve`, { _csrf: csrf });
  return (await db.expense.findUnique({ where: { id } })).approvalStatus;
}

test('HTML approve is tiered by amount (defaults 500 / 5000); a refused approval leaves no ledger entry', async () => {
  const { churchId } = await signedInChurch('tier-html');
  const admin = await db.user.findFirst({ where: { churchId } });
  const treasurer = await userWithRole(churchId, 'tre', 'TREASURER');
  const finAdmin = await userWithRole(churchId, 'fin', 'FINANCE_ADMIN');
  const owner = await userWithRole(churchId, 'own', 'NONE', 'ADMIN');

  const small = await recordExpense(churchId, 400, admin.id);
  const medium = await recordExpense(churchId, 800, admin.id);
  const large = await recordExpense(churchId, 6000, admin.id);

  assert.strictEqual(await approveVia(treasurer.client, small.id), 'PAID', 'treasurer approves a small expense');
  assert.strictEqual(await approveVia(treasurer.client, medium.id), 'SUBMITTED', 'treasurer cannot approve a medium expense');
  assert.strictEqual(await approveVia(treasurer.client, large.id), 'SUBMITTED', 'treasurer cannot approve a large expense');
  assert.strictEqual(await approveVia(finAdmin.client, medium.id), 'PAID', 'finance admin approves a medium expense');
  assert.strictEqual(await approveVia(finAdmin.client, large.id), 'SUBMITTED', 'finance admin cannot approve a large expense');
  const refused = await db.expense.findUnique({ where: { id: large.id } });
  assert.strictEqual(refused.journalEntryId, null, 'no journal entry for a refused approval');
  assert.strictEqual(refused.approvedBy, null);
  assert.strictEqual(await approveVia(owner.client, large.id), 'PAID', 'admin approves a large expense');
  assert.strictEqual(await db.journalEntry.count({ where: { churchId } }), 3, 'exactly the three approved expenses are posted');
});

test('maker-checker still applies at every tier: an admin cannot approve their own large expense', async () => {
  const { client: c, churchId } = await signedInChurch('tier-self');
  const admin = await db.user.findFirst({ where: { churchId } });
  const large = await recordExpense(churchId, 9000, admin.id);
  assert.strictEqual(await approveVia(c, large.id), 'SUBMITTED');
  const page = (await c.getHtml('/finance/expenses')).text;
  assert.match(page, /Awaiting another fund manager/);
});

test('the expenses list shows who is needed instead of an Approve button the user cannot use', async () => {
  const { churchId } = await signedInChurch('tier-ui');
  const admin = await db.user.findFirst({ where: { churchId } });
  const treasurer = await userWithRole(churchId, 'tre-ui', 'TREASURER');
  const small = await recordExpense(churchId, 100, admin.id);
  const large = await recordExpense(churchId, 7000, admin.id);
  const html = (await treasurer.client.getHtml('/finance/expenses')).text;
  assert.match(html, new RegExp(`/finance/expenses/${small.id}/approve`));
  assert.doesNotMatch(html, new RegExp(`/finance/expenses/${large.id}/approve`));
  assert.match(html, /Needs an Admin/);
});

test('changing the limits changes who can approve', async () => {
  const { client: c, churchId } = await signedInChurch('tier-limits');
  const admin = await db.user.findFirst({ where: { churchId } });
  const treasurer = await userWithRole(churchId, 'tre-lim', 'TREASURER');
  const e = await recordExpense(churchId, 800, admin.id);
  assert.strictEqual(await approveVia(treasurer.client, e.id), 'SUBMITTED');
  const csrf = csrfOf((await c.getHtml('/finance/settings')).text);
  await c.postForm('/finance/settings', { receiptPrefix: 'RCT', voucherPrefix: 'PV', smallExpenseMax: '1000', mediumExpenseMax: '5000', _csrf: csrf });
  assert.strictEqual(await approveVia(treasurer.client, e.id), 'PAID', 'raising the small limit lets a treasurer approve it');
});

test('settings refuse a small limit above the medium limit', async () => {
  const { client: c, churchId } = await signedInChurch('tier-validate');
  const csrf = csrfOf((await c.getHtml('/finance/settings')).text);
  const r = await c.postForm('/finance/settings', { receiptPrefix: 'RCT', voucherPrefix: 'PV', smallExpenseMax: '9000', mediumExpenseMax: '100', _csrf: csrf });
  assert.strictEqual(r.status, 302);
  assert.strictEqual(await db.financeSetting.count({ where: { churchId } }), 0);
});

test('JSON API approve enforces the same tiers', async () => {
  const { churchId } = await signedInChurch('tier-api');
  const admin = await db.user.findFirst({ where: { churchId } });
  const treasurer = await userWithRole(churchId, 'tre-api', 'TREASURER');
  const owner = await userWithRole(churchId, 'own-api', 'NONE', 'ADMIN');
  const large = await recordExpense(churchId, 7500, admin.id);
  const post = async (actor) => (await actor.client.postJson(`/api/finance/expenses/${large.id}/approve`, {})).status;
  assert.strictEqual(await post(treasurer), 403);
  assert.strictEqual((await db.expense.findUnique({ where: { id: large.id } })).approvalStatus, 'SUBMITTED');
  assert.strictEqual(await post(owner), 200);
  assert.strictEqual((await db.expense.findUnique({ where: { id: large.id } })).approvalStatus, 'PAID');
});
