'use strict';
// Finance gap-closure: accounting (trial balance + ledger), fund/expense/
// budget-line edit, finance settings and the finance audit trail.
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
async function submitExpense(c, fund, cat, amount = '120', description = 'Generator fuel') {
  const csrf = await csrfFrom(c, '/finance/expenses');
  const r = await c.postForm('/finance/expenses', { spentOn: '2026-06-01', expenseCatId: String(cat.id), amount, fundId: String(fund.id), description, _csrf: csrf });
  assert.strictEqual(r.status, 302);
}
async function seedFundAndCat(churchId) {
  const fund = await db.fund.create({ data: { churchId, name: 'General', fundType: 'GENERAL', code: 'GEN' } });
  const cat = await db.expenseCategory.findFirst({ where: { churchId, categoryName: 'Utilities' } });
  return { fund, cat };
}

test('accounting page: trial balance balances after income and an approved expense; CSVs export it', async () => {
  const { client: c, churchId } = await signedInChurch('acct-tb');
  const { fund, cat } = await seedFundAndCat(churchId);
  await ledger.postCashIncome(tenantDb(churchId), churchId, { date: '2026-06-01', amount: 500, category: 'Tithe', fundId: fund.id, sourceType: 'TEST' });
  await submitExpense(c, fund, cat, '120');
  const expense = await db.expense.findFirst({ where: { churchId } });
  await approveExpense(churchId, expense.id);

  const page = await c.getHtml('/finance/accounting');
  assert.strictEqual(page.status, 200);
  assert.match(page.text, /Balanced/);
  assert.match(page.text, /Trial balance/);

  const tb = await c.getCsv('/finance/accounting/trial-balance.csv');
  assert.strictEqual(tb.status, 200);
  const rows = tb.text.split('\r\n').slice(1).map((l) => l.split(','));
  const debit = rows.reduce((s, r) => s + Number(r[r.length - 2] || 0), 0);
  const credit = rows.reduce((s, r) => s + Number(r[r.length - 1] || 0), 0);
  assert.ok(debit > 0);
  assert.strictEqual(Math.round(debit * 100), Math.round(credit * 100), 'trial balance CSV must balance');

  const gl = await c.getCsv('/finance/accounting/ledger.csv');
  assert.strictEqual(gl.status, 200);
  assert.match(gl.text, /^Entry,Date,Source/);
  assert.ok(gl.text.split('\r\n').length >= 5, 'ledger has lines for both entries');
});

test('accounting is gated: anonymous redirected, user without a finance role is 403', async () => {
  const { churchId } = await signedInChurch('acct-gate');
  const anon = client();
  const r = await anon.getHtml('/finance/accounting');
  assert.strictEqual(r.status, 302);
  const email = uniqueEmail('plain');
  await db.user.create({ data: { churchId, username: `plain-${Date.now()}`, email, passwordHash: await bcrypt.hash('password123', 10), role: 'VIEWER', financeRole: 'NONE' } });
  const plain = client();
  await plain.postJson('/login', { email, password: 'password123' });
  for (const p of ['/finance/accounting', '/finance/accounting/trial-balance.csv', '/finance/audit', '/finance/settings']) {
    assert.strictEqual((await plain.getHtml(p)).status, 403, p);
  }
});

test('manager-only edit pages send a signed-out visitor to /login rather than a bare 403', async () => {
  const { churchId } = await signedInChurch('edit-anon');
  const fund = await db.fund.create({ data: { churchId, name: 'F', fundType: 'GENERAL' } });
  const anon = client();
  for (const p of [`/finance/funds/${fund.id}/edit`, '/finance/expenses/1/edit', '/finance/budgets/1/lines/1/edit']) {
    assert.strictEqual((await anon.getHtml(p)).status, 302, p);
  }
});

test('fund edit and restriction toggle update the fund and are audited; duplicate name is rejected', async () => {
  const { client: c, churchId } = await signedInChurch('fund-edit');
  const fund = await db.fund.create({ data: { churchId, name: 'Welfare', fundType: 'WELFARE', code: 'WEL' } });
  await db.fund.create({ data: { churchId, name: 'Building', fundType: 'BUILDING', code: 'BLD' } });

  assert.strictEqual((await c.getHtml(`/finance/funds/${fund.id}/edit`)).status, 200);
  let csrf = await csrfFrom(c, `/finance/funds/${fund.id}/edit`);
  await c.postForm(`/finance/funds/${fund.id}`, { name: 'Welfare & Care', code: 'wel', fundType: 'WELFARE', openingBalance: '50', responsibleOfficer: 'Ama', restricted: '1', _csrf: csrf });
  let after = await db.fund.findUnique({ where: { id: fund.id } });
  assert.strictEqual(after.name, 'Welfare & Care');
  assert.strictEqual(after.code, 'WEL');
  assert.strictEqual(after.openingBalance, 50);
  assert.strictEqual(after.restricted, true);

  csrf = await csrfFrom(c, '/finance/funds');
  await c.postForm(`/finance/funds/${fund.id}/restriction`, { restricted: '0', _csrf: csrf });
  after = await db.fund.findUnique({ where: { id: fund.id } });
  assert.strictEqual(after.restricted, false);

  csrf = await csrfFrom(c, `/finance/funds/${fund.id}/edit`);
  const dup = await c.postForm(`/finance/funds/${fund.id}`, { name: 'Building', fundType: 'WELFARE', _csrf: csrf });
  assert.match(dup.location, /\/edit$/);
  assert.strictEqual((await db.fund.findUnique({ where: { id: fund.id } })).name, 'Welfare & Care');

  const kinds = (await db.activityLog.findMany({ where: { churchId } })).map((a) => a.kind);
  assert.ok(kinds.includes('fund_updated') && kinds.includes('fund_restriction_updated'));
});

test('fund edit cannot touch another church\'s fund', async () => {
  const a = await signedInChurch('fund-xt-a');
  const b = await signedInChurch('fund-xt-b');
  const fundB = await db.fund.create({ data: { churchId: b.churchId, name: 'B Fund', fundType: 'GENERAL' } });
  const csrf = await csrfFrom(a.client, '/finance/funds');
  assert.strictEqual((await a.client.getHtml(`/finance/funds/${fundB.id}/edit`)).status, 404);
  const r = await a.client.postForm(`/finance/funds/${fundB.id}`, { name: 'Hijacked', _csrf: csrf });
  assert.strictEqual(r.status, 404);
  assert.strictEqual((await db.fund.findUnique({ where: { id: fundB.id } })).name, 'B Fund');
});

test('expense edit: submitted is fully editable (editor becomes recorder), rejected resubmits, paid locks the money fields', async () => {
  const { client: c, churchId } = await signedInChurch('exp-edit');
  const { fund, cat } = await seedFundAndCat(churchId);
  await submitExpense(c, fund, cat, '100', 'Original');
  const e = await db.expense.findFirst({ where: { churchId } });
  assert.strictEqual((await c.getHtml(`/finance/expenses/${e.id}/edit`)).status, 200);

  let csrf = await csrfFrom(c, `/finance/expenses/${e.id}/edit`);
  await c.postForm(`/finance/expenses/${e.id}/edit`, { spentOn: '2026-06-02', expenseCatId: String(cat.id), amount: '135.5', fundId: String(fund.id), description: 'Corrected', paidTo: 'ECG', _csrf: csrf });
  let after = await db.expense.findUnique({ where: { id: e.id } });
  assert.strictEqual(after.amount, 135.5);
  assert.strictEqual(after.description, 'Corrected');
  assert.strictEqual(after.approvalStatus, 'SUBMITTED');

  // Reject, then edit: goes back to SUBMITTED with the rejection cleared.
  await db.expense.update({ where: { id: e.id }, data: { approvalStatus: 'REJECTED', rejectedAt: new Date(), approvalNote: 'no receipt' } });
  csrf = await csrfFrom(c, `/finance/expenses/${e.id}/edit`);
  await c.postForm(`/finance/expenses/${e.id}/edit`, { spentOn: '2026-06-02', expenseCatId: String(cat.id), amount: '135.5', fundId: String(fund.id), description: 'Corrected, receipt attached', receiptAttached: '1', _csrf: csrf });
  after = await db.expense.findUnique({ where: { id: e.id } });
  assert.strictEqual(after.approvalStatus, 'SUBMITTED');
  assert.strictEqual(after.rejectedAt, null);
  assert.strictEqual(after.receiptAttached, true);

  // Approve, then try to change the money: only descriptive fields move, voucher re-syncs.
  await approveExpense(churchId, e.id);
  csrf = await csrfFrom(c, `/finance/expenses/${e.id}/edit`);
  await c.postForm(`/finance/expenses/${e.id}/edit`, { spentOn: '2026-07-09', amount: '9999', fundId: String(fund.id), description: 'Fuel for generator', paidTo: 'Kofi Fuels', _csrf: csrf });
  after = await db.expense.findUnique({ where: { id: e.id } });
  assert.strictEqual(after.approvalStatus, 'PAID');
  assert.strictEqual(after.amount, 135.5, 'amount locked once paid');
  assert.strictEqual(after.spentOn.toISOString().slice(0, 10), '2026-06-02', 'date locked once paid');
  assert.strictEqual(after.description, 'Fuel for generator');
  const voucher = await db.paymentVoucher.findFirst({ where: { expenseId: e.id } });
  assert.strictEqual(voucher.receivedBy, 'Kofi Fuels');

  // No free-form status override exists (it would bypass maker-checker).
  const bypass = await c.postForm(`/finance/expenses/${e.id}/status`, { status: 'PAID', _csrf: csrf });
  assert.strictEqual(bypass.status, 404);
});

test('a recorder who edits their own submitted expense still cannot approve it, and a second user\'s edit transfers ownership', async () => {
  const { client: c, churchId } = await signedInChurch('exp-maker');
  const { fund, cat } = await seedFundAndCat(churchId);
  await submitExpense(c, fund, cat);
  const e = await db.expense.findFirst({ where: { churchId } });
  const email = uniqueEmail('editor');
  const editorUser = await db.user.create({ data: { churchId, username: `editor-${Date.now()}`, email, passwordHash: await bcrypt.hash('password123', 10), role: 'VIEWER', financeRole: 'TREASURER' } });
  const editor = client();
  await editor.postJson('/login', { email, password: 'password123' });
  const csrf = await csrfFrom(editor, `/finance/expenses/${e.id}/edit`);
  await editor.postForm(`/finance/expenses/${e.id}/edit`, { spentOn: '2026-06-01', expenseCatId: String(cat.id), amount: '120', fundId: String(fund.id), description: 'Tweaked by editor', _csrf: csrf });
  assert.strictEqual((await db.expense.findUnique({ where: { id: e.id } })).recordedBy, editorUser.id);
  const approveAttempt = await editor.postForm(`/finance/expenses/${e.id}/approve`, { _csrf: csrf });
  assert.strictEqual(approveAttempt.status, 302);
  assert.strictEqual((await db.expense.findUnique({ where: { id: e.id } })).approvalStatus, 'SUBMITTED', 'editor cannot approve their own edit');
});

test('budget line edit updates the line; closed budget refuses; other church\'s line is 404', async () => {
  const a = await signedInChurch('bl-edit');
  const b = await signedInChurch('bl-edit-other');
  const csrf = await csrfFrom(a.client, '/finance/budgets');
  await a.client.postForm('/finance/budgets', { name: '2026 Budget', year: '2026', scope: 'ANNUAL', _csrf: csrf });
  const budget = await db.financeBudget.findFirst({ where: { churchId: a.churchId } });
  const detailCsrf = await csrfFrom(a.client, `/finance/budgets/${budget.id}`);
  await a.client.postForm(`/finance/budgets/${budget.id}/lines`, { lineType: 'EXPENSE', category: 'Utilities', amount: '1000', _csrf: detailCsrf });
  const line = await db.financeBudgetLine.findFirst({ where: { budgetId: budget.id } });

  assert.strictEqual((await a.client.getHtml(`/finance/budgets/${budget.id}/lines/${line.id}/edit`)).status, 200);
  const editCsrf = await csrfFrom(a.client, `/finance/budgets/${budget.id}/lines/${line.id}/edit`);
  await a.client.postForm(`/finance/budgets/${budget.id}/lines/${line.id}/edit`, { lineType: 'EXPENSE', category: 'Utilities & fuel', amount: '1500', _csrf: editCsrf });
  const after = await db.financeBudgetLine.findUnique({ where: { id: line.id } });
  assert.strictEqual(after.category, 'Utilities & fuel');
  assert.strictEqual(after.amount, 1500);

  const bogus = await b.client.getHtml(`/finance/budgets/${budget.id}/lines/${line.id}/edit`);
  assert.strictEqual(bogus.status, 404);

  await db.financeBudget.update({ where: { id: budget.id }, data: { status: 'CLOSED' } });
  await a.client.postForm(`/finance/budgets/${budget.id}/lines/${line.id}/edit`, { lineType: 'EXPENSE', category: 'Nope', amount: '1', _csrf: editCsrf });
  assert.strictEqual((await db.financeBudgetLine.findUnique({ where: { id: line.id } })).category, 'Utilities & fuel');

  // The per-budget CSV used to 500: '/finance/budgets/:id' matched '57.csv' first and Number('57.csv') is NaN.
  const one = await a.client.getCsv(`/finance/budgets/${budget.id}.csv`);
  assert.strictEqual(one.status, 200);
  assert.match(one.text, /^Type,Category,Fund,Budgeted,Actual,Variance/);
  assert.match(one.text, /Nope|Utilities & fuel/);

  const csv = await a.client.getCsv('/finance/budgets.csv');
  assert.strictEqual(csv.status, 200);
  assert.match(csv.text, /2026 Budget/);
  assert.doesNotMatch(csv.text, /undefined/);
});

test('finance settings: prefixes change numbering, bad input is rejected, change is audited', async () => {
  const { client: c, churchId } = await signedInChurch('fin-settings');
  const { fund, cat } = await seedFundAndCat(churchId);
  const page = await c.getHtml('/finance/settings');
  assert.strictEqual(page.status, 200);
  assert.match(page.text, /PV-\d{4}-0001/);

  let csrf = csrfOf(page.text);
  const bad = await c.postForm('/finance/settings', { receiptPrefix: '', voucherPrefix: 'PV', smallExpenseMax: '1', mediumExpenseMax: '2', _csrf: csrf });
  assert.strictEqual(bad.status, 302);
  assert.strictEqual(await db.financeSetting.count({ where: { churchId } }), 0, 'invalid input saves nothing');

  await c.postForm('/finance/settings', { receiptPrefix: 'grace church', voucherPrefix: 'gc pay', smallExpenseMax: '200', mediumExpenseMax: '2000', _csrf: csrf });
  const s = await db.financeSetting.findFirst({ where: { churchId } });
  assert.strictEqual(s.receiptPrefix, 'GRACE-CHURCH');
  assert.strictEqual(s.voucherPrefix, 'GC-PAY');
  assert.strictEqual(s.mediumExpenseMax, 2000);

  // Saving again updates in place rather than creating a second row.
  csrf = await csrfFrom(c, '/finance/settings');
  await c.postForm('/finance/settings', { receiptPrefix: 'RCT', voucherPrefix: 'GC-PAY', smallExpenseMax: '300', mediumExpenseMax: '2000', _csrf: csrf });
  assert.strictEqual(await db.financeSetting.count({ where: { churchId } }), 1);

  await submitExpense(c, fund, cat);
  const e = await db.expense.findFirst({ where: { churchId } });
  await approveExpense(churchId, e.id);
  const voucher = await db.paymentVoucher.findFirst({ where: { expenseId: e.id } });
  assert.match(voucher.voucherNo, /^GC-PAY-2026-\d{4}$/);
  assert.ok((await db.activityLog.findMany({ where: { churchId, kind: 'finance_settings_updated' } })).length >= 2);
});

test('audit trail lists finance events with the actor, filters by kind, and is tenant-scoped', async () => {
  const a = await signedInChurch('audit-a');
  const b = await signedInChurch('audit-b');
  const csrf = await csrfFrom(a.client, '/finance/funds');
  await a.client.postForm('/finance/funds', { name: 'Audited Fund', fundType: 'GENERAL', _csrf: csrf });
  await db.activityLog.create({ data: { churchId: a.churchId, kind: 'member_created', description: 'not a finance event' } });
  await db.activityLog.create({ data: { churchId: b.churchId, kind: 'fund_created', description: 'Created finance fund SECRET-B' } });

  const page = await a.client.getHtml('/finance/audit');
  assert.strictEqual(page.status, 200);
  assert.match(page.text, /Audited Fund/);
  assert.match(page.text, /Admin Person/);
  assert.doesNotMatch(page.text, /not a finance event/);
  assert.doesNotMatch(page.text, /SECRET-B/);

  const filtered = await a.client.getHtml('/finance/audit?kind=expense_approved');
  assert.doesNotMatch(filtered.text, /Audited Fund/);
  // An unknown kind falls back to the full finance list instead of erroring.
  assert.strictEqual((await a.client.getHtml('/finance/audit?kind=bogus')).status, 200);
});

test('every logActivity kind written by the finance routes is listed on the audit page', async () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(require.resolve('../routes-pg-html/finance.js'), 'utf8');
  const used = new Set([...src.matchAll(/logActivity\(\s*[\w.]+,\s*'([a-z_]+)'/g)].map((m) => m[1]));
  const listed = new Set([...src.match(/const FINANCE_ACTIVITY_KINDS = \[([\s\S]*?)\];/)[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
  const missing = [...used].filter((k) => !listed.has(k));
  assert.deepStrictEqual(missing, [], `finance activity kinds missing from the audit page: ${missing.join(', ')}`);
});

test('finance overview: shows collections, income by type and approvals; actions return only to /finance', async () => {
  const { client: c, churchId } = await signedInChurch('fin-overview');
  const { fund, cat } = await seedFundAndCat(churchId);
  await submitExpense(c, fund, cat, '150', 'Overview fuel');
  await submitExpense(c, fund, cat, '90', 'Overview paper');

  const page = await c.getHtml('/finance');
  assert.strictEqual(page.status, 200);
  for (const text of ['Sunday collections', 'Income by type', 'Waiting for approval', 'Recent transactions', 'Overview fuel']) {
    assert.match(page.text, new RegExp(text), `overview shows ${text}`);
  }
  // The admin recorded both, so they cannot approve them; the two-person rule shows here too.
  assert.match(page.text, /Awaiting another fund manager/);
  assert.match(page.text, /name="return_to" value="\/finance"/);

  const [first, second] = await db.expense.findMany({ where: { churchId }, orderBy: { id: 'asc' } });
  const csrf = csrfOf(page.text);
  const back = await c.postForm(`/finance/expenses/${first.id}/reject`, { _csrf: csrf, return_to: '/finance' });
  assert.strictEqual(back.status, 302);
  assert.strictEqual(back.location, '/finance');
  const elsewhere = await c.postForm(`/finance/expenses/${second.id}/reject`, { _csrf: csrf, return_to: 'https://evil.example/' });
  assert.strictEqual(elsewhere.status, 302);
  assert.strictEqual(elsewhere.location, '/finance/expenses', 'any other return_to falls back to the register');
});
