'use strict';
// Platform › Payments (routes-pg-html/platform-payments.js): recording what a
// church paid, extending its Pro plan by the months covered, revenue by
// month, and deleting a mistaken record.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const OTPAuth = require('otpauth');
const { createTenantApp } = require('../lib/tenant-http');
const { db } = require('../lib/tenant');
const { signupChurch } = require('../lib/provision');
const { createTotpSecret, createRecoveryCodes } = require('../lib/mfa');
const { revenueSummary } = require('../routes-pg-html/platform-payments');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const DAY = 24 * 60 * 60 * 1000;
const churchIds = [];
const operatorIds = [];
let server, base;

test.before(async () => {
  const app = createTenantApp({ pool });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  server.close();
  const where = { churchId: { in: churchIds } };
  await db.emailLog.deleteMany({ where });
  await db.securityAuditLog.deleteMany({ where });
  await db.account.deleteMany({ where });
  await db.user.deleteMany({ where });
  await db.specialCategory.deleteMany({ where });
  await db.serviceType.deleteMany({ where });
  await db.expenseCategory.deleteMany({ where });
  await db.church.deleteMany({ where: { id: { in: churchIds } } });
  await db.platformPayment.deleteMany({ where: { payerChurchId: { in: churchIds } } });
  await db.platformAuditLog.deleteMany({ where: { operatorId: { in: operatorIds } } });
  await db.platformOperator.deleteMany({ where: { id: { in: operatorIds } } });
  await db.$disconnect();
  await pool.end();
});

const unique = (tag) => `${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;

async function proChurch(tag, proUntil) {
  const { church } = await signupChurch({ churchName: `${tag} Church`, name: 'Owner', email: unique(tag), password: 'password123' });
  churchIds.push(church.id);
  await db.church.update({ where: { id: church.id }, data: { plan: 'pro', proSince: new Date(), proUntil } });
  return church.id;
}

function client() {
  let cookie;
  const remember = (res) => {
    for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) if (c.startsWith('connect.sid=')) cookie = c.split(';')[0];
  };
  return {
    async page(p) {
      const res = await fetch(base + p, { headers: cookie ? { cookie } : {}, redirect: 'manual' });
      remember(res);
      return { status: res.status, location: res.headers.get('location'), text: await res.text() };
    },
    async form(p, fields, from = p) {
      const page = await this.page(from);
      const csrf = (page.text.match(/name="_csrf" value="([^"]*)"/) || [])[1] || '';
      const res = await fetch(base + p, {
        method: 'POST', redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
        body: new URLSearchParams({ ...fields, _csrf: csrf }).toString(),
      });
      remember(res);
      return { status: res.status, location: res.headers.get('location'), text: await res.text() };
    },
  };
}

async function signedInOperator() {
  const email = unique('op-pay');
  const totp = createTotpSecret(email);
  const row = await db.platformOperator.create({ data: {
    email, passwordHash: await bcrypt.hash('operator-password-123', 4),
    totpEnabled: true, totpSecret: totp.secret, totpRecoveryCodes: createRecoveryCodes().serialized,
  } });
  operatorIds.push(row.id);
  const c = client();
  await c.form('/platform/login', { email, password: 'operator-password-123' });
  const code = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(totp.secret), digits: 6, period: 30 }).generate();
  assert.strictEqual((await c.form('/platform/login/mfa', { code }, '/platform/login/mfa')).location, '/platform');
  return c;
}

test('revenue: this month, last month, this year, all time, and the last 12 months', () => {
  const now = new Date('2026-10-15T00:00:00Z');
  const r = revenueSummary([
    { amount: '500.00', paidOn: new Date('2026-10-02') },
    { amount: '300', paidOn: new Date('2026-09-20') },
    { amount: '100', paidOn: new Date('2025-12-01') },
    { amount: '50', paidOn: new Date('2024-01-01') },
  ], now);
  assert.deepStrictEqual([r.month, r.previous, r.ytd, r.total], [500, 300, 800, 950]);
  assert.strictEqual(Object.keys(r.byMonth).length, 12);
  assert.strictEqual(r.byMonth['2025-12'], 100);
  assert.strictEqual(r.byMonth['2024-01'], undefined, 'older than 12 months');
});

test('recording a payment logs it and extends Pro by the months it covers; deleting leaves the plan', async () => {
  const until = new Date(Date.now() + 5 * DAY);
  const churchId = await proChurch('pay-extend', until);
  const op = await signedInOperator();

  const page = await op.page('/platform/payments');
  assert.strictEqual(page.status, 200);
  assert.match(page.text, /Record a payment/);
  assert.match(page.text, /aria-current="page">Payments</, 'the Payments tab is current');

  const recorded = await op.form('/platform/payments', { churchId, amount: '1200', paidOn: new Date().toISOString().slice(0, 10), method: 'MOMO', reference: 'MP123', months: '12', extend: '1' }, '/platform/payments');
  assert.strictEqual(recorded.status, 302);
  const payment = await db.platformPayment.findFirst({ where: { payerChurchId: churchId } });
  assert.strictEqual(Number(payment.amount), 1200);
  assert.strictEqual(payment.reference, 'MP123');
  assert.match(payment.churchName, /pay-extend Church/);
  const church = await db.church.findUnique({ where: { id: churchId } });
  assert.strictEqual(church.proUntil.getTime(), until.getTime() + 360 * DAY, '12 months from the current end');
  assert.ok(await db.platformAuditLog.findFirst({ where: { churchId, event: 'platform.payment_recorded' } }));

  const listed = (await op.page('/platform/payments')).text;
  assert.match(listed, /GH₵ 1,200\.00/);
  assert.match((await op.page(`/platform/churches/${churchId}`)).text, /MP123/, 'shown on the church\'s page');

  // Refused: no amount, a future date, an odd period.
  for (const bad of [{ amount: '0' }, { paidOn: '2999-01-01' }, { months: '5' }]) {
    await op.form('/platform/payments', { churchId, amount: '50', paidOn: '2026-10-01', method: 'CASH', months: '0', ...bad }, '/platform/payments');
  }
  assert.strictEqual(await db.platformPayment.count({ where: { payerChurchId: churchId } }), 1);

  // Not extending: the plan stays as it is.
  await op.form('/platform/payments', { churchId, amount: '50', paidOn: '2026-10-01', method: 'CASH', months: '1' }, '/platform/payments');
  assert.strictEqual((await db.church.findUnique({ where: { id: churchId } })).proUntil.getTime(), church.proUntil.getTime());

  await op.form(`/platform/payments/${payment.id}/delete`, {}, '/platform/payments');
  assert.strictEqual(await db.platformPayment.count({ where: { id: payment.id } }), 0);
  assert.strictEqual((await db.church.findUnique({ where: { id: churchId } })).proUntil.getTime(), church.proUntil.getTime(), 'deleting a record leaves the plan');
  assert.ok(await db.platformAuditLog.findFirst({ where: { churchId, event: 'platform.payment_deleted' } }));
});

test('church users cannot reach Payments', async () => {
  const c = client();
  const res = await c.page('/platform/payments');
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.location, '/platform/login');
});
