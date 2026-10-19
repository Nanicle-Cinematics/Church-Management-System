'use strict';
// Regressions found by the depth comparison against the old single-tenant
// finance code: budget account picker, income project tag/category/receipt
// redirect, expense receipt flag, and the list/detail columns that were lost.
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



async function csrfFrom(c, path) { return csrfOf((await c.getHtml(path)).text); }

test('budget lines: the account picker offers both kinds and the server refuses a mismatched account', async () => {
  const { client: c, churchId } = await signedInChurch('bl-accounts');
  await db.fund.create({ data: { churchId, name: 'General', fundType: 'GENERAL', code: 'GEN' } });
  const incomeAcc = await db.account.findFirst({ where: { churchId, accountType: 'INCOME' } });
  const expenseAcc = await db.account.findFirst({ where: { churchId, accountType: 'EXPENSE' } });
  let csrf = await csrfFrom(c, '/finance/budgets');
  await c.postForm('/finance/budgets', { name: '2026 Budget', year: '2026', scope: 'ANNUAL', _csrf: csrf });
  const budget = await db.financeBudget.findFirst({ where: { churchId } });

  const page = (await c.getHtml(`/finance/budgets/${budget.id}`)).text;
  assert.match(page, /optgroup label="Income accounts"/);
  assert.match(page, /optgroup label="Expense accounts"/);
  assert.ok(page.includes(`value="${expenseAcc.id}"`), 'an expense account is selectable when adding a line');

  csrf = await csrfFrom(c, `/finance/budgets/${budget.id}`);
  await c.postForm(`/finance/budgets/${budget.id}/lines`, { lineType: 'EXPENSE', category: 'Wrong kind', accountId: String(incomeAcc.id), amount: '100', _csrf: csrf });
  assert.strictEqual(await db.financeBudgetLine.count({ where: { budgetId: budget.id } }), 0, 'expense line with an income account is refused');
  await c.postForm(`/finance/budgets/${budget.id}/lines`, { lineType: 'EXPENSE', category: 'Right kind', accountId: String(expenseAcc.id), amount: '100', _csrf: csrf });
  const line = await db.financeBudgetLine.findFirst({ where: { budgetId: budget.id } });
  assert.strictEqual(line.accountId, expenseAcc.id);

  csrf = await csrfFrom(c, `/finance/budgets/${budget.id}/lines/${line.id}/edit`);
  await c.postForm(`/finance/budgets/${budget.id}/lines/${line.id}/edit`, { lineType: 'EXPENSE', category: 'Right kind', accountId: String(incomeAcc.id), amount: '100', _csrf: csrf });
  assert.strictEqual((await db.financeBudgetLine.findUnique({ where: { id: line.id } })).accountId, expenseAcc.id, 'editing to a mismatched account is refused');
});

test('income: project tag is saved, a foreign project is refused, unknown category falls back, and saving opens the receipt', async () => {
  const a = await signedInChurch('inc-proj-a');
  const b = await signedInChurch('inc-proj-b');
  const fund = await db.fund.create({ data: { churchId: a.churchId, name: 'General', fundType: 'GENERAL', code: 'GEN' } });
  const project = await db.financeProject.create({ data: { churchId: a.churchId, name: 'Roof', targetAmount: 1000, status: 'ACTIVE' } });
  const foreign = await db.financeProject.create({ data: { churchId: b.churchId, name: 'Foreign', targetAmount: 1, status: 'ACTIVE' } });

  let csrf = await csrfFrom(a.client, '/finance/income');
  const r = await a.client.postForm('/finance/income', { transactionDate: '2026-07-10', category: 'not-a-category', amount: '100', fundId: String(fund.id), projectId: String(project.id), _csrf: csrf });
  assert.match(r.location, /^\/finance\/receipts\/.+\/print\?new=1$/, 'redirects to the new receipt');
  const row = await db.incomeRecord.findFirst({ where: { churchId: a.churchId } });
  assert.strictEqual(row.projectId, project.id);
  assert.strictEqual(row.category, 'other', 'an unknown category falls back to other');
  assert.match((await a.client.getHtml('/finance/income')).text, /Roof/, 'the list shows the project');

  csrf = await csrfFrom(a.client, '/finance/income');
  await a.client.postForm('/finance/income', { transactionDate: '2026-07-11', category: 'donation', amount: '50', fundId: String(fund.id), projectId: String(foreign.id), _csrf: csrf });
  assert.strictEqual(await db.incomeRecord.count({ where: { churchId: a.churchId } }), 1, 'another church\'s project id creates nothing');

  const api = await a.client.postJson('/api/finance/income', { transactionDate: '2026-07-12', category: 'Tithe', amount: 20, fundId: fund.id, projectId: project.id });
  assert.strictEqual(api.status, 201);
  assert.strictEqual((await db.incomeRecord.findFirst({ where: { churchId: a.churchId }, orderBy: { id: 'desc' } })).projectId, project.id, 'the JSON API takes projectId too');
  const apiBad = await a.client.postJson('/api/finance/income', { transactionDate: '2026-07-12', category: 'Tithe', amount: 20, fundId: fund.id, projectId: foreign.id });
  assert.strictEqual(apiBad.status, 400);
});

test('expenses: receipt-attached is captured on create and shown in the list', async () => {
  const { client: c, churchId } = await signedInChurch('exp-receipt');
  const fund = await db.fund.create({ data: { churchId, name: 'General', fundType: 'GENERAL', code: 'GEN' } });
  const cat = await db.expenseCategory.findFirst({ where: { churchId, categoryName: 'Utilities' } });
  const csrf = await csrfFrom(c, '/finance/expenses');
  await c.postForm('/finance/expenses', { spentOn: '2026-06-01', expenseCatId: String(cat.id), amount: '60', fundId: String(fund.id), description: 'With receipt', receiptAttached: '1', _csrf: csrf });
  await c.postForm('/finance/expenses', { spentOn: '2026-06-02', expenseCatId: String(cat.id), amount: '70', fundId: String(fund.id), description: 'No receipt', _csrf: csrf });
  const rows = await db.expense.findMany({ where: { churchId }, orderBy: { id: 'asc' } });
  assert.deepStrictEqual(rows.map((e) => e.receiptAttached), [true, false]);
  const html = (await c.getHtml('/finance/expenses')).text;
  assert.strictEqual((html.match(/Receipt attached/g) || []).length, 2, 'once in the create form, once on the flagged expense');
});

test('budgets list shows lines and separate income / expense actual vs budget', async () => {
  const { client: c, churchId } = await signedInChurch('bud-overview');
  const fund = await db.fund.create({ data: { churchId, name: 'General', fundType: 'GENERAL', code: 'GEN' } });
  const budget = await db.financeBudget.create({ data: { churchId, name: 'Overview Budget', year: 2026, scope: 'ANNUAL', status: 'APPROVED' } });
  await db.financeBudgetLine.create({ data: { churchId, budgetId: budget.id, lineType: 'INCOME', category: 'Tithes', amount: 2000 } });
  await db.financeBudgetLine.create({ data: { churchId, budgetId: budget.id, lineType: 'EXPENSE', category: 'Utilities', amount: 900 } });
  await ledger.postCashIncome(tenantDb(churchId), churchId, { date: '2026-06-01', amount: 750, category: 'Tithe', fundId: fund.id, sourceType: 'TEST' });
  const html = (await c.getHtml('/finance/budgets')).text;
  assert.match(html, /Income \(actual \/ budget\)/);
  assert.match(html, /750\.00[^<]*\/[^<]*2,000\.00/, 'income actual 750 of 2,000 budgeted');
  assert.match(html, /0\.00[^<]*\/[^<]*900\.00/, 'expense actual 0 of 900 budgeted');
});

test('vouchers list shows payee, method and who prepared it', async () => {
  const { client: c, churchId } = await signedInChurch('vch-cols');
  const admin = await db.user.findFirst({ where: { churchId } });
  const fund = await db.fund.create({ data: { churchId, name: 'General', fundType: 'GENERAL', code: 'GEN' } });
  const cat = await db.expenseCategory.findFirst({ where: { churchId, categoryName: 'Utilities' } });
  const e = await db.expense.create({ data: { churchId, expenseCatId: cat.id, category: 'Utilities', amount: 150, spentOn: new Date('2026-06-05'), description: 'Power', paidTo: 'ECG Ghana', paymentMethod: 'Mobile Money', fundId: fund.id, approvalStatus: 'PAID', recordedBy: admin.id } });
  await db.paymentVoucher.create({ data: { churchId, voucherNo: 'PV-2026-0001', expenseId: e.id, voucherDate: new Date('2026-06-05'), amountInWords: 'One hundred and fifty', preparedBy: admin.id } });
  const html = (await c.getHtml('/finance/vouchers')).text;
  assert.match(html, /ECG Ghana/);
  assert.match(html, /Mobile Money/);
  assert.match(html, /Admin Person/);
  assert.match(html, /Payee/);
});

test('project detail shows dates, payee, method and voucher, and is not capped at 50 expenses', async () => {
  const { client: c, churchId } = await signedInChurch('proj-detail');
  const admin = await db.user.findFirst({ where: { churchId } });
  const cat = await db.expenseCategory.findFirst({ where: { churchId, categoryName: 'Utilities' } });
  const project = await db.financeProject.create({ data: { churchId, name: 'Hall', targetAmount: 5000, status: 'ACTIVE', responsibleOfficer: 'Kwame', startDate: new Date('2026-02-01'), endDate: new Date('2026-12-31') } });
  const rows = [];
  for (let i = 1; i <= 55; i++) rows.push({ churchId, expenseCatId: cat.id, category: 'Utilities', amount: i, spentOn: new Date('2026-03-01'), description: `Item ${i}`, projectId: project.id, approvalStatus: 'SUBMITTED', recordedBy: admin.id });
  await db.expense.createMany({ data: rows });
  const first = await db.expense.findFirst({ where: { churchId, description: 'Item 55' } });
  await db.expense.update({ where: { id: first.id }, data: { paidTo: 'Builder Co', paymentMethod: 'Cheque', approvalStatus: 'PAID' } });
  await db.paymentVoucher.create({ data: { churchId, voucherNo: 'PV-2026-0009', expenseId: first.id, voucherDate: new Date('2026-03-01'), amountInWords: 'Fifty five' } });
  const html = (await c.getHtml(`/finance/projects/${project.id}`)).text;
  assert.match(html, /2026-02-01/);
  assert.match(html, /2026-12-31/);
  assert.match(html, /Builder Co/);
  assert.match(html, /Cheque/);
  assert.match(html, /PV-2026-0009/);
  assert.match(html, /Item 1</, 'the oldest of 55 expenses is still listed');
  assert.match((await c.getHtml('/finance/projects')).text, /Kwame/, 'the projects list shows the responsible officer');
});

test('harvest detail shows each pledge\'s outstanding balance', async () => {
  const { client: c, churchId } = await signedInChurch('harv-out');
  const member = await db.member.create({ data: { churchId, firstName: 'Efua', lastName: 'Darko' } });
  const harvest = await db.harvest.create({ data: { churchId, harvestType: 'OTHER', harvestYear: 2026, harvestName: 'Outstanding Harvest' } });
  await db.pledge.create({ data: { churchId, memberId: member.id, harvestId: harvest.id, pledgedAmount: 500, paidAmount: 125, pledgeDate: new Date('2026-01-15'), status: 'PARTIAL' } });
  const html = (await c.getHtml(`/finance/harvests/${harvest.id}`)).text;
  assert.match(html, /Outstanding/);
  assert.match(html, /375\.00/, 'outstanding = 500 - 125');
});

test('expense notes: captured on create, shown escaped, editable (also once paid), and accepted by the JSON API', async () => {
  const { client: c, churchId } = await signedInChurch('exp-notes');
  const admin = await db.user.findFirst({ where: { churchId } });
  const fund = await db.fund.create({ data: { churchId, name: 'General', fundType: 'GENERAL', code: 'GEN' } });
  const cat = await db.expenseCategory.findFirst({ where: { churchId, categoryName: 'Utilities' } });

  let csrf = await csrfFrom(c, '/finance/expenses');
  await c.postForm('/finance/expenses', { spentOn: '2026-06-01', expenseCatId: String(cat.id), amount: '60', fundId: String(fund.id), description: 'Notes test', notes: '  Paid in two instalments <b>x</b>  ', _csrf: csrf });
  const e = await db.expense.findFirst({ where: { churchId } });
  assert.strictEqual(e.notes, 'Paid in two instalments <b>x</b>', 'trimmed and stored as typed');
  const list = (await c.getHtml('/finance/expenses')).text;
  assert.ok(list.includes('Paid in two instalments &lt;b&gt;x&lt;/b&gt;'), 'shown in the list');
  assert.ok(!list.includes('<b>x</b>'), 'and HTML-escaped');

  await c.postForm('/finance/expenses', { spentOn: '2026-06-02', expenseCatId: String(cat.id), amount: '70', fundId: String(fund.id), description: 'Long note', notes: 'n'.repeat(900), _csrf: csrf });
  const long = await db.expense.findFirst({ where: { churchId, description: 'Long note' } });
  assert.strictEqual(long.notes.length, 500, 'capped at 500 characters');
  await c.postForm('/finance/expenses', { spentOn: '2026-06-03', expenseCatId: String(cat.id), amount: '80', fundId: String(fund.id), description: 'Blank note', notes: '   ', _csrf: csrf });
  assert.strictEqual((await db.expense.findFirst({ where: { churchId, description: 'Blank note' } })).notes, null, 'a blank note is stored as null');

  csrf = await csrfFrom(c, `/finance/expenses/${e.id}/edit`);
  assert.ok((await c.getHtml(`/finance/expenses/${e.id}/edit`)).text.includes('Paid in two instalments'), 'the edit form is prefilled');
  await c.postForm(`/finance/expenses/${e.id}/edit`, { spentOn: '2026-06-01', expenseCatId: String(cat.id), amount: '60', fundId: String(fund.id), description: 'Notes test', notes: 'Updated note', _csrf: csrf });
  assert.strictEqual((await db.expense.findUnique({ where: { id: e.id } })).notes, 'Updated note');

  // Once paid the money fields lock, but notes stay editable (descriptive).
  await db.expense.update({ where: { id: e.id }, data: { approvalStatus: 'PAID', approvedBy: admin.id } });
  csrf = await csrfFrom(c, `/finance/expenses/${e.id}/edit`);
  await c.postForm(`/finance/expenses/${e.id}/edit`, { description: 'Notes test', notes: 'Note added after payment', amount: '9999', _csrf: csrf });
  const paid = await db.expense.findUnique({ where: { id: e.id } });
  assert.strictEqual(paid.notes, 'Note added after payment');
  assert.strictEqual(paid.amount, 60, 'the amount is still locked');

  const api = await c.postJson('/api/finance/expenses', { spentOn: '2026-06-04', expenseCatId: cat.id, amount: 15, fundId: fund.id, description: 'API', notes: 'from the API' });
  assert.strictEqual(api.status, 201);
  assert.strictEqual((await db.expense.findFirst({ where: { churchId, description: 'API' } })).notes, 'from the API');
});
