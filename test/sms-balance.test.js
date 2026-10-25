'use strict';
// Platform › SMS balance (lib/sms-balance.js, routes-pg-html/platform-sms.js):
// reading the gateway's balance, alerting operators once (then daily) when
// it is below the alert level, clearing on top-up, and the console page.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const OTPAuth = require('otpauth');
const { createTenantApp } = require('../lib/tenant-http');
const { db } = require('../lib/tenant');
const { signupChurch } = require('../lib/provision');
const { createTotpSecret, createRecoveryCodes } = require('../lib/mfa');
const { parseSmsBalance } = require('../lib/delivery');
const smsBalance = require('../lib/sms-balance');

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
  await db.platformSetting.deleteMany({ where: { key: { in: ['sms_balance', 'sms_balance_threshold'] } } });
  await db.platformAuditLog.deleteMany({ where: { operatorId: { in: operatorIds } } });
  await db.platformOperator.deleteMany({ where: { id: { in: operatorIds } } });
  await db.$disconnect();
  await pool.end();
});

const unique = (tag) => `${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;

async function proChurch(tag, proUntil) {
  const { church } = await signupChurch({ churchName: `${tag} Church`, name: 'Owner', email: unique(tag), password: 'Tr0ubadour-7!' });
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
  const email = unique('op-sms-bal');
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

test('the balance is read from the shapes gateways answer with', () => {
  assert.strictEqual(parseSmsBalance({ status: 'success', balance: '1,240' }), 1240);
  assert.strictEqual(parseSmsBalance({ status: 'success', data: { sms_balance: 58, main_balance: '12.50' } }), 58);
  assert.strictEqual(parseSmsBalance({ summary: { balance: '0' } }), 0);
  assert.strictEqual(parseSmsBalance({ error: 'invalid api key' }), null);
  assert.strictEqual(parseSmsBalance(null), null);
});

test('a low balance alerts once, again after a day, and clears on top-up', async () => {
  await db.platformSetting.deleteMany({ where: { key: { in: ['sms_balance', 'sms_balance_threshold'] } } });
  await smsBalance.setSetting('sms_balance_threshold', 100);
  const alerts = [];
  const alert = async (text, opts) => { alerts.push({ text, opts }); };
  const reply = (balance) => async () => ({ ok: true, provider: 'mnotify', balance, raw: `{"balance":${balance}}` });
  const t0 = new Date('2026-10-15T08:00:00Z');
  const at = (hours) => new Date(t0.getTime() + hours * 3600 * 1000);

  await smsBalance.checkSmsBalance({ alert, now: at(0), fetch: reply(500) });
  assert.strictEqual(alerts.length, 0, 'above the level');
  const low = await smsBalance.checkSmsBalance({ alert, now: at(1), fetch: reply(40) });
  assert.strictEqual(low.alerted, true);
  assert.strictEqual(alerts.length, 1);
  assert.match(alerts[0].text, /SMS balance is 40, below the alert level of 100/);
  assert.strictEqual(alerts[0].opts.subject, 'Church Manager: SMS balance is low');
  await smsBalance.checkSmsBalance({ alert, now: at(5), fetch: reply(30) });
  assert.strictEqual(alerts.length, 1, 'not again within the day');
  await smsBalance.checkSmsBalance({ alert, now: at(26), fetch: reply(20) });
  assert.strictEqual(alerts.length, 2, 'again the next day while still low');

  // A failed check keeps the last good figure and says why.
  await smsBalance.checkSmsBalance({ alert, now: at(27), fetch: async () => ({ ok: false, provider: 'mnotify', error: 'HTTP 502: Bad gateway', raw: '<html>' }) });
  let state = await smsBalance.balanceState();
  assert.strictEqual(state.balance, 20);
  assert.strictEqual(state.error, 'HTTP 502: Bad gateway');

  // Topped up: cleared, so the next drop alerts straight away.
  await smsBalance.checkSmsBalance({ alert, now: at(28), fetch: reply(5000) });
  state = await smsBalance.balanceState();
  assert.strictEqual(state.alertedAt, null);
  await smsBalance.checkSmsBalance({ alert, now: at(29), fetch: reply(10) });
  assert.strictEqual(alerts.length, 3);

  // Under the test runner the real check never reaches the gateway.
  assert.strictEqual((await smsBalance.checkSmsBalance({ alert })).skipped, true);
});

test('the console\'s SMS tab shows the balance and saves the alert level', async () => {
  await smsBalance.setSetting('sms_balance', { balance: 40, provider: 'mnotify', checkedAt: new Date().toISOString(), balanceAt: new Date().toISOString(), raw: '{"balance":40}', error: null, alertedAt: null });
  await smsBalance.setSetting('sms_balance_threshold', 100);
  const op = await signedInOperator();
  const page = await op.page('/platform/sms');
  assert.strictEqual(page.status, 200);
  assert.match(page.text, /SMS balance/);
  assert.match(page.text, /below alert level/);
  assert.match(page.text, /aria-current="page">SMS</);
  assert.match((await op.page('/platform')).text, /SMS balance<\/a> · low/, 'flagged on the Overview too');

  await op.form('/platform/sms/threshold', { threshold: '250' }, '/platform/sms');
  assert.strictEqual(await smsBalance.balanceThreshold(), 250);
  await op.form('/platform/sms/threshold', { threshold: '-5' }, '/platform/sms');
  assert.strictEqual(await smsBalance.balanceThreshold(), 250, 'refused');

  await op.form('/platform/sms/check', {}, '/platform/sms');
  assert.match((await op.page('/platform/sms')).text, /Not checked: Running under the test runner/);
  assert.strictEqual((await client().page('/platform/sms')).location, '/platform/login');
});
