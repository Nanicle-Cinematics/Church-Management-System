'use strict';
// Drop-downs that replaced typed text: the shared control (lib/choice.js), and the forms that use it.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { createTenantApp } = require('../lib/tenant-http');
const { db } = require('../lib/tenant');
const { signupChurch } = require('../lib/provision');
const { choiceField, readChoice, OTHER } = require('../lib/choice');
const { incomeSubcategoryOptions, INCOME_SUBCATEGORIES, expenseSubcategoryOptions } = require('../lib/choice-lists');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const PASSWORD = 'Tr0ubadour-7!';
const churchIds = [];
let server, base;

function client() {
  let cookie;
  const remember = (res) => { for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) if (c.startsWith('connect.sid=')) cookie = c.split(';')[0]; };
  const api = {
    async page(p) { const res = await fetch(base + p, { headers: cookie ? { cookie } : {}, redirect: 'manual' }); remember(res); return { status: res.status, location: res.headers.get('location'), text: await res.text() }; },
    async form(p, fields, from = p) {
      const csrf = ((await api.page(from)).text.match(/name="_csrf" value="([^"]*)"/) || [])[1] || '';
      const res = await fetch(base + p, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) }, body: new URLSearchParams({ ...fields, _csrf: csrf }).toString() });
      remember(res); return { status: res.status, location: res.headers.get('location'), text: await res.text() };
    },
  };
  return api;
}

test.before(async () => {
  const app = createTenantApp({ pool });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  server.close();
  const where = { churchId: { in: churchIds } };
  for (const m of ['paymentVoucher', 'expense', 'journalLine', 'journalEntry', 'financeReceipt', 'incomeRecord', 'preachingPlan', 'allowance', 'activityLog', 'securityAuditLog', 'fund', 'account', 'user', 'specialCategory', 'serviceType', 'expenseCategory']) {
    if (db[m]) await db[m].deleteMany({ where }).catch(() => {});
  }
  await db.church.deleteMany({ where: { id: { in: churchIds } } }).catch(() => {});
  await db.$disconnect();
  await pool.end();
});

test('the control offers the usual answers, keeps a custom one under Other…, and reads either back', () => {
  const html = choiceField({ name: 'service', label: 'Service', options: ['Sunday Service', 'Wedding Service'], value: 'Wedding Service' });
  assert.match(html, /<option value="Wedding Service" selected>/);
  assert.match(html, new RegExp(`<option value="${OTHER}">Other…</option>`));
  assert.match(html, /name="service_other"[^>]* hidden>/, 'the box for typing is hidden until Other… is chosen');
  const custom = choiceField({ name: 'service', label: 'Service', options: ['Sunday Service'], value: 'Sunday 1st service' });
  assert.match(custom, new RegExp(`<option value="${OTHER}" selected>`), 'a value that is not on the list shows as Other…');
  assert.match(custom, /value="Sunday 1st service"/);
  assert.doesNotMatch(custom, /name="service_other"[^>]* hidden>/, 'with its box already open');
  assert.match(choiceField({ name: 'x', label: 'X', options: ['a'], required: true }), /required data-required="1"/);
  assert.ok(!/<script|\son[a-z]+=/i.test(html + custom), 'no inline script or handler');
  assert.match(choiceField({ name: 'x', label: '<b>X</b>', options: ['<i>'] }), /&lt;b&gt;X&lt;\/b&gt;[\s\S]*&lt;i&gt;/, 'text is escaped');

  assert.strictEqual(readChoice({ service: 'Sunday Service' }, 'service'), 'Sunday Service');
  assert.strictEqual(readChoice({ service: OTHER, service_other: '  Sunday   1st service ' }, 'service'), 'Sunday 1st service');
  assert.strictEqual(readChoice({ service: 'Sunday Service', service_other: 'ignored' }, 'service'), 'Sunday Service', 'typed text only counts under Other…');
  assert.strictEqual(readChoice({ service: OTHER }, 'service'), '');
  assert.strictEqual(readChoice({}, 'service'), '');
  assert.strictEqual(readChoice({ service: OTHER, service_other: 'x'.repeat(500) }, 'service', 80).length, 80);
});

test('income subcategories belong to a category, and every category has some', () => {
  const opts = incomeSubcategoryOptions();
  for (const cat of Object.keys(INCOME_SUBCATEGORIES)) assert.ok(opts.some((o) => o.group === cat), cat);
  assert.ok(opts.every((o) => o.value && o.label && o.group));
});

test('the forms show drop-downs, and what is chosen or typed is what gets saved', async () => {
  const email = `choice-${process.pid}-${Date.now()}@example.test`;
  const { church } = await signupChurch({ churchName: 'Choice Church', name: 'Owner', email, password: PASSWORD });
  churchIds.push(church.id);
  const admin = client();
  await admin.form('/login', { email, password: PASSWORD }, '/login');

  const income = await admin.page('/finance/income');
  assert.match(income.text, /<select name="subcategory"[^>]*data-group-from="category"/);
  assert.match(income.text, /<option value="Thanksgiving" data-group="donation">/);
  assert.match(income.text, /<option value="Hall rental" data-group="rent">/);
  const cash = await admin.page('/finance/cash-counts?new=1');
  assert.match(cash.text, /<select name="serviceLabel"[^>]*>[\s\S]*<option value="Sunday Service">/, 'cash count service lists the church\'s service types');
  const plan = await admin.page('/preaching');
  assert.match(plan.text, /<select name="serviceLabel"[^>]*>[\s\S]*<option value="Wedding Service">/);

  // income: a listed subcategory, then a typed one
  await admin.form('/finance/income', { transactionDate: '2026-10-20', category: 'donation', subcategory: 'Thanksgiving', amount: '50', paymentMethod: 'Cash', receivedFrom: 'A. Giver' }, '/finance/income');
  await admin.form('/finance/income', { transactionDate: '2026-10-21', category: 'other', subcategory: OTHER, subcategory_other: 'Sale of old pews', amount: '20', paymentMethod: 'Cash', receivedFrom: 'B. Buyer' }, '/finance/income');
  const rows = await db.incomeRecord.findMany({ where: { churchId: church.id }, orderBy: { amount: 'desc' } });
  assert.deepStrictEqual(rows.map((r) => r.subcategory), ['Thanksgiving', 'Sale of old pews']);

  // preaching plan: a listed service, and the edit page re-selects it; a typed one reopens as Other…
  await admin.form('/preaching', { preachDate: '2031-03-02', serviceLabel: 'Sunday Service' }, '/preaching');
  await admin.form('/preaching', { preachDate: '2031-03-09', serviceLabel: OTHER, serviceLabel_other: '9:00 AM service' }, '/preaching');
  const plans = await db.preachingPlan.findMany({ where: { churchId: church.id }, orderBy: { preachDate: 'asc' } });
  assert.deepStrictEqual(plans.map((p) => p.serviceLabel), ['Sunday Service', '9:00 AM service']);
  assert.match((await admin.page(`/preaching/${plans[0].id}/edit`)).text, /<option value="Sunday Service" selected>/);
  const typed = (await admin.page(`/preaching/${plans[1].id}/edit`)).text;
  assert.match(typed, new RegExp(`<option value="${OTHER}" selected>`));
  assert.match(typed, /value="9:00 AM service"/);
});

test('Utilities has its own subcategories, and an expense keeps the one chosen or typed', async () => {
  const opts = expenseSubcategoryOptions([{ id: 7, categoryName: 'Utilities' }, { id: 8, categoryName: 'Transport' }]);
  assert.ok(['Electricity', 'Water', 'Internet and data', 'Telephone and airtime', 'Gas (LPG)', 'Refuse collection'].every((v) => opts.some((o) => o.value === v && o.group === '7')));
  assert.ok(!opts.some((o) => o.group === '8'), 'only Utilities has a list; other categories use Other…');

  const email = `util-${process.pid}-${Date.now()}@example.test`;
  const { church } = await signupChurch({ churchName: 'Utilities Church', name: 'Owner', email, password: PASSWORD });
  churchIds.push(church.id);
  const admin = client();
  await admin.form('/login', { email, password: PASSWORD }, '/login');
  const utilities = await db.expenseCategory.findFirst({ where: { churchId: church.id, categoryName: 'Utilities' } });
  assert.ok(utilities, 'a new church starts with a Utilities category');

  const page = await admin.page('/finance/expenses');
  assert.match(page.text, /<select name="subcategory"[^>]*data-group-from="expenseCatId"/);
  assert.match(page.text, new RegExp(`<option value="Electricity" data-group="${utilities.id}">`));

  const base = { spentOn: '2026-10-20', expenseCatId: String(utilities.id), amount: '120', paymentMethod: 'Cash', description: 'Bill' };
  await admin.form('/finance/expenses', { ...base, description: 'ECG', subcategory: 'Electricity' }, '/finance/expenses');
  await admin.form('/finance/expenses', { ...base, description: 'Borehole', subcategory: OTHER, subcategory_other: 'Borehole pump repair' }, '/finance/expenses');
  const rows = await db.expense.findMany({ where: { churchId: church.id }, orderBy: { id: 'asc' } });
  assert.deepStrictEqual(rows.map((r) => [r.category, r.subcategory]), [['Utilities', 'Electricity'], ['Utilities', 'Borehole pump repair']]);
  const list = (await admin.page('/finance/expenses')).text;
  assert.ok(list.includes('Electricity') && list.includes('Borehole pump repair'), 'the list shows each expense\'s subcategory');

  // editing keeps it, and changing it saves
  assert.match((await admin.page(`/finance/expenses/${rows[0].id}/edit`)).text, /<option value="Electricity" data-group="\d+" selected>/);
  await admin.form(`/finance/expenses/${rows[0].id}/edit`, { ...base, description: 'ECG', subcategory: 'Water' }, `/finance/expenses/${rows[0].id}/edit`);
  assert.strictEqual((await db.expense.findUnique({ where: { id: rows[0].id } })).subcategory, 'Water');
});
