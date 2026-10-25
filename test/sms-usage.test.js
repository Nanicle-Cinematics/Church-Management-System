'use strict';
// SMS use and monthly allowances (lib/sms-usage.js): counting each church's
// texts, refusing a send that would go over its allowance (whole, never
// half-sent), platform messages exempt, and the operator's usage table.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const OTPAuth = require('otpauth');
const { createTenantApp } = require('../lib/tenant-http');
const { db } = require('../lib/tenant');
const { signupChurch } = require('../lib/provision');
const { createTotpSecret, createRecoveryCodes } = require('../lib/mfa');
const { sendSmsBatch } = require('../lib/delivery');
const usage = require('../lib/sms-usage');

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
  await db.smsUsage.deleteMany({ where: { churchId: { in: churchIds } } });
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
  const email = unique('op-sms-use');
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

async function freeChurch(tag) {
  const email = unique(tag);
  const { church } = await signupChurch({ churchName: `${tag} Church`, name: 'Owner', email, password: 'Tr0ubadour-7!' });
  churchIds.push(church.id);
  return { churchId: church.id, email };
}

test('pages per text, and allowances by plan or set by the operator', () => {
  assert.strictEqual(usage.smsSegments('Hello'), 1);
  assert.strictEqual(usage.smsSegments('a'.repeat(160)), 1);
  assert.strictEqual(usage.smsSegments('a'.repeat(161)), 2);
  assert.strictEqual(usage.smsSegments('ɛ'.repeat(70)), 1, 'Twi letters use the 70-character pages');
  assert.strictEqual(usage.smsSegments('ɛ'.repeat(71)), 2);
  assert.strictEqual(usage.allowanceFor({ plan: 'free' }), 100);
  assert.strictEqual(usage.allowanceFor({ plan: 'pro', proUntil: null }), 2000);
  assert.strictEqual(usage.allowanceFor({ plan: 'pro', proUntil: new Date(0) }), 100, 'a lapsed Pro is Free');
  assert.strictEqual(usage.allowanceFor({ plan: 'free', smsMonthlyAllowance: 500 }), 500);
  assert.strictEqual(usage.allowanceFor({ plan: 'pro', smsMonthlyAllowance: 0 }), 0);
});

test('a send that would go over the allowance is refused whole; platform messages are exempt', async () => {
  const { churchId } = await freeChurch('sms-allow');
  await db.church.update({ where: { id: churchId }, data: { smsMonthlyAllowance: 3 } });
  await usage.recordUsage(churchId, 2, 'Hello');
  assert.deepStrictEqual(await usage.usageFor(churchId), { messages: 2, segments: 2 });

  const over = await sendSmsBatch(['+233244000001', '+233244000002'], 'Hi', { churchId });
  assert.strictEqual(over.ok, false);
  assert.strictEqual(over.limited, true);
  assert.match(over.error, /Monthly SMS allowance reached: 2 of 3 used this month, 1 left, and this needs 2/);

  const one = await sendSmsBatch(['+233244000001'], 'Hi', { churchId });
  assert.strictEqual(one.dryRun, true, 'within the allowance, it goes on to send (a dry run here)');
  assert.deepStrictEqual(await usage.usageFor(churchId), { messages: 2, segments: 2 }, 'a dry run is not counted');

  const platform = await sendSmsBatch(['+233244000001', '+233244000002', '+233244000003'], 'Renew', { churchId, platform: true });
  assert.strictEqual(platform.dryRun, true, 'never limited');

  await usage.recordUsage(churchId, 1, 'x'.repeat(200));
  assert.deepStrictEqual(await usage.usageFor(churchId), { messages: 3, segments: 4 });
  assert.strictEqual((await usage.allowanceCheck(churchId, 1)).ok, false);
});

test('the church sees its month\'s use; the operator sees every church\'s and sets allowances', async () => {
  const { churchId, email } = await freeChurch('sms-report');
  await usage.recordUsage(churchId, 40, 'Hello all');

  const admin = client();
  await fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'Tr0ubadour-7!' }) })
    .then((r) => { const c = r.headers.getSetCookie().find((x) => x.startsWith('connect.sid=')); admin.cookie = c.split(';')[0]; });
  const card = await (await fetch(`${base}/communications/email-settings`, { headers: { cookie: admin.cookie } })).text();
  assert.match(card, /40 of 100 texts/);
  assert.match(card, /60 left/);

  const op = await signedInOperator();
  const page = (await op.page('/platform/sms')).text;
  assert.match(page, /Texts in /);
  assert.match(page, new RegExp(`/platform/churches/${churchId}/sms-allowance`));
  assert.match(page, /40% of 100/);

  await op.form(`/platform/churches/${churchId}/sms-allowance`, { allowance: '500' }, '/platform/sms');
  assert.strictEqual((await db.church.findUnique({ where: { id: churchId } })).smsMonthlyAllowance, 500);
  assert.match((await op.page('/platform/sms')).text, /8% of 500/);
  await op.form(`/platform/churches/${churchId}/sms-allowance`, { allowance: '-1' }, '/platform/sms');
  assert.strictEqual((await db.church.findUnique({ where: { id: churchId } })).smsMonthlyAllowance, 500, 'refused');
  await op.form(`/platform/churches/${churchId}/sms-allowance`, { allowance: '' }, '/platform/sms');
  assert.strictEqual((await db.church.findUnique({ where: { id: churchId } })).smsMonthlyAllowance, null, 'back to the plan');
  assert.ok(await db.platformAuditLog.findFirst({ where: { churchId, event: 'platform.sms_allowance' } }));
});
