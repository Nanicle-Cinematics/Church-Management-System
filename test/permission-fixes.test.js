'use strict';
// Found in the per-role permissions review (docs/AUTHORIZATION_MATRIX.md):
//  - a Cashier records money but must not be able to undo a posted entry
//    (reversing is for Treasurers, Finance Admins and Admins);
//  - the chart of accounts is finance data;
//  - the event check-in token (the secret in the QR code) is only for people
//    who can open the QR page, never a read-only account.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { createTenantApp } = require('../lib/tenant-http');
const { db } = require('../lib/tenant');
const { signupChurch } = require('../lib/provision');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const PASSWORD = 'Tr0ubadour-7!';
let server, base, churchId;
const who = {};

const unique = (tag) => `${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;

async function signIn(email) {
  let cookie;
  const res = await fetch(base + '/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) });
  assert.strictEqual(res.status, 200);
  for (const c of res.headers.getSetCookie()) if (c.startsWith('connect.sid=')) cookie = c.split(';')[0];
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, redirect: 'manual', headers: { 'content-type': 'application/json', cookie }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* an HTML page */ }
    return { status: r.status, text, json };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b || {}), del: (p) => call('DELETE', p) };
}

async function staff(tag, role, financeRole) {
  const email = unique(tag);
  await db.user.create({ data: { churchId, username: `${tag}-${Date.now()}`, email, passwordHash: await bcrypt.hash(PASSWORD, 4), role, financeRole } });
  return signIn(email);
}

test.before(async () => {
  const app = createTenantApp({ pool });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  const email = unique('perm-owner');
  const { church } = await signupChurch({ churchName: 'Permission Fixes Church', name: 'Owner', email, password: PASSWORD });
  churchId = church.id;
  who.admin = await signIn(email);
  who.cashier = await staff('cashier', 'EDITOR', 'CASHIER');
  who.viewerCashier = await staff('viewer-cashier', 'VIEWER', 'CASHIER');
  who.treasurer = await staff('treasurer', 'EDITOR', 'TREASURER');
  who.financeAdmin = await staff('finadmin', 'VIEWER', 'FINANCE_ADMIN');
  who.auditor = await staff('auditor', 'EDITOR', 'AUDITOR');
  who.editor = await staff('editor', 'EDITOR', 'NONE');
  who.viewer = await staff('viewer', 'VIEWER', 'NONE');
});

test.after(async () => {
  server.close();
  const where = { churchId };
  await db.activityLog.deleteMany({ where });
  await db.incomeRecord.deleteMany({ where });
  await db.event.deleteMany({ where });
  await db.account.deleteMany({ where });
  await db.fund.deleteMany({ where });
  await db.user.deleteMany({ where });
  await db.specialCategory.deleteMany({ where });
  await db.serviceType.deleteMany({ where });
  await db.expenseCategory.deleteMany({ where });
  await db.church.deleteMany({ where: { id: churchId } });
  await db.$disconnect();
  await pool.end();
});

const REVERSALS = [
  ['DELETE', '/api/finance/income/1'], ['DELETE', '/api/finance/day-borns/1'], ['DELETE', '/api/finance/services/1'], ['DELETE', '/api/finance/harvests/1'],
  ['POST', '/finance/income/1/delete'], ['POST', '/finance/day-borns/1/delete'], ['POST', '/finance/services/1/delete'], ['POST', '/finance/harvests/1/delete'],
];

test('a Cashier cannot reverse posted money, by any route; fund managers can (they reach the record)', async () => {
  for (const [method, p] of REVERSALS) {
    for (const name of ['cashier', 'viewerCashier', 'auditor', 'editor', 'viewer']) {
      assert.strictEqual((await (method === 'DELETE' ? who[name].del(p) : who[name].post(p))).status, 403, `${name} ${method} ${p}`);
    }
    for (const name of ['treasurer', 'financeAdmin', 'admin']) {
      const status = (await (method === 'DELETE' ? who[name].del(p) : who[name].post(p))).status;
      assert.strictEqual(status, 404, `${name} ${method} ${p} passes the guard and finds no record 1`);
    }
  }
});

test('the Reverse button is offered to fund managers only', async () => {
  const income = await db.incomeRecord.create({ data: { churchId, transactionDate: new Date(), category: 'Offering', amount: 40, recordedBy: null } });
  const reverseForm = `/finance/income/${income.id}/delete`;
  assert.ok((await who.cashier.get('/finance/income')).text.includes('Offering'), 'the Cashier still sees the record');
  assert.ok(!(await who.cashier.get('/finance/income')).text.includes(reverseForm), 'but no Reverse button');
  assert.ok((await who.treasurer.get('/finance/income')).text.includes(reverseForm), 'a Treasurer gets it');
  assert.ok((await who.admin.get('/finance/income')).text.includes(reverseForm), 'an Admin gets it');
  // A cashier cannot reverse it by posting to the URL either, and it stays on the books.
  assert.strictEqual((await who.cashier.post(reverseForm)).status, 403);
  assert.strictEqual((await db.incomeRecord.findUnique({ where: { id: income.id } })).deletedAt, null);
  // A fund manager can.
  assert.strictEqual((await who.treasurer.post(reverseForm)).status, 302);
  assert.notStrictEqual((await db.incomeRecord.findUnique({ where: { id: income.id } })).deletedAt, null);
});

test('the chart of accounts needs finance access', async () => {
  for (const name of ['editor', 'viewer']) assert.strictEqual((await who[name].get('/api/finance/accounts')).status, 403, name);
  for (const name of ['cashier', 'auditor', 'treasurer', 'financeAdmin', 'admin']) {
    const r = await who[name].get('/api/finance/accounts');
    assert.strictEqual(r.status, 200, name);
    assert.ok(Array.isArray(r.json) && r.json.length > 0, `${name} sees the accounts`);
  }
});

test('the event check-in token reaches Admins and Editors only, never a read-only account', async () => {
  const ev = await db.event.create({ data: { churchId, title: 'Token Service', eventType: 'SERVICE', startsAt: new Date(), checkinToken: 'c0ffee'.repeat(5) + 'ab' } });
  for (const name of ['admin', 'editor', 'cashier', 'treasurer']) {
    const list = (await who[name].get('/api/events')).json.find((e) => e.id === ev.id);
    assert.strictEqual(list.checkinToken, ev.checkinToken, `${name} list`);
    assert.strictEqual((await who[name].get(`/api/events/${ev.id}`)).json.checkinToken, ev.checkinToken, `${name} detail`);
  }
  for (const name of ['viewer', 'viewerCashier', 'financeAdmin']) {
    const list = (await who[name].get('/api/events')).json.find((e) => e.id === ev.id);
    assert.ok(list, `${name} still sees the event`);
    assert.ok(!('checkinToken' in list), `${name} list has no token`);
    const detail = (await who[name].get(`/api/events/${ev.id}`)).json;
    assert.strictEqual(detail.title, 'Token Service');
    assert.ok(!('checkinToken' in detail), `${name} detail has no token`);
    assert.ok(!JSON.stringify(detail).includes(ev.checkinToken), `${name} never gets the token anywhere in the response`);
  }
});
