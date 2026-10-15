'use strict';
// Platform › Operators (routes-pg-html/platform-operators-admin.js): add an
// operator (password shown once), reset password or two-factor, rename,
// disable and enable (never yourself), and change your own password.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const OTPAuth = require('otpauth');
const { createTenantApp } = require('../lib/tenant-http');
const { db } = require('../lib/tenant');
const { signupChurch } = require('../lib/provision');
const { createTotpSecret, createRecoveryCodes } = require('../lib/mfa');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const DAY = 24 * 60 * 60 * 1000;
const churchIds = [];
const operatorIds = [];
let lastOperator = null;
let server, base;

test.before(async () => {
  const app = createTenantApp({ pool });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  server.close();
  const where = { churchId: { in: churchIds } };
  await db.member.deleteMany({ where });
  await db.activityLog.deleteMany({ where });
  await db.emailLog.deleteMany({ where });
  await db.securityAuditLog.deleteMany({ where });
  await db.account.deleteMany({ where });
  await db.user.deleteMany({ where });
  await db.specialCategory.deleteMany({ where });
  await db.serviceType.deleteMany({ where });
  await db.expenseCategory.deleteMany({ where });
  await db.church.deleteMany({ where: { id: { in: churchIds } } });
  await db.platformAuditLog.deleteMany({ where: { operatorId: { in: operatorIds } } });
  await db.platformOperator.deleteMany({ where: { OR: [{ id: { in: operatorIds } }, { email: { endsWith: `-${process.pid}@ops.example.test` } }] } });
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
  const email = unique('op-admin');
  const totp = createTotpSecret(email);
  const row = await db.platformOperator.create({ data: {
    email, passwordHash: await bcrypt.hash('operator-password-123', 4),
    totpEnabled: true, totpSecret: totp.secret, totpRecoveryCodes: createRecoveryCodes().serialized,
  } });
  operatorIds.push(row.id);
  lastOperator = row;
  const c = client();
  await c.form('/platform/login', { email, password: 'operator-password-123' });
  const code = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(totp.secret), digits: 6, period: 30 }).generate();
  assert.strictEqual((await c.form('/platform/login/mfa', { code }, '/platform/login/mfa')).location, '/platform');
  return c;
}

const newEmail = (tag) => `${tag}-${Date.now()}-${process.pid}@ops.example.test`;

test('add an operator: a password shown once, two-factor at first sign-in', async () => {
  const op = await signedInOperator();
  const list = await op.page('/platform/operators');
  assert.match(list.text, /aria-current="page">Operators</);
  assert.match(list.text, /· you/);

  const email = newEmail('added');
  const added = await op.form('/platform/operators', { email, displayName: '"Esi Mensah"' }, '/platform/operators');
  assert.strictEqual(added.status, 200, 'shown on the page itself, not via a redirect');
  const password = (added.text.match(/<code>([^<]+)<\/code>/) || [])[1];
  assert.ok(password && password.length >= 20);
  const row = await db.platformOperator.findUnique({ where: { email } });
  assert.strictEqual(row.displayName, 'Esi Mensah', 'stray quotes dropped');
  assert.strictEqual(row.totpEnabled, false);
  assert.ok(await bcrypt.compare(password, row.passwordHash));
  assert.notStrictEqual((await op.page('/platform/operators')).text.includes(password), true, 'not shown again');

  const dup = await op.form('/platform/operators', { email }, '/platform/operators');
  assert.strictEqual(dup.status, 302);
  assert.match((await op.page('/platform/operators')).text, /is already an operator/);
});

test('reset password and two-factor, rename, disable and enable; never yourself', async () => {
  const op = await signedInOperator();
  const me = lastOperator;
  const other = await db.platformOperator.create({ data: { email: newEmail('other'), passwordHash: await bcrypt.hash('x'.repeat(12), 4), totpEnabled: true, totpSecret: 'ABC', failedAttempts: 3 } });

  const reset = await op.form(`/platform/operators/${other.id}/reset-password`, {}, '/platform/operators');
  const password = (reset.text.match(/<code>([^<]+)<\/code>/) || [])[1];
  let row = await db.platformOperator.findUnique({ where: { id: other.id } });
  assert.ok(await bcrypt.compare(password, row.passwordHash));
  assert.strictEqual(row.failedAttempts, 0);

  await op.form(`/platform/operators/${other.id}/reset-2fa`, {}, '/platform/operators');
  row = await db.platformOperator.findUnique({ where: { id: other.id } });
  assert.deepStrictEqual([row.totpEnabled, row.totpSecret], [false, null]);

  await op.form(`/platform/operators/${other.id}/rename`, { displayName: 'Kojo' }, '/platform/operators');
  assert.strictEqual((await db.platformOperator.findUnique({ where: { id: other.id } })).displayName, 'Kojo');

  await op.form(`/platform/operators/${other.id}/disable`, {}, '/platform/operators');
  assert.ok((await db.platformOperator.findUnique({ where: { id: other.id } })).disabledAt);
  await op.form(`/platform/operators/${other.id}/enable`, {}, '/platform/operators');
  assert.strictEqual((await db.platformOperator.findUnique({ where: { id: other.id } })).disabledAt, null);

  await op.form(`/platform/operators/${me.id}/disable`, {}, '/platform/operators');
  assert.strictEqual((await db.platformOperator.findUnique({ where: { id: me.id } })).disabledAt, null);
  assert.match((await op.page('/platform/operators')).text, /You cannot disable yourself/);
  await op.form(`/platform/operators/${me.id}/reset-password`, {}, '/platform/operators');
  assert.match((await op.page('/platform/operators')).text, /Use Change my password/);
  assert.ok(await db.platformAuditLog.findFirst({ where: { operatorId: me.id, event: 'operator.disabled' } }));
});

test('change my own password, only with the current one', async () => {
  const op = await signedInOperator();
  const me = lastOperator;
  await op.form('/platform/operators/me/password', { current: 'wrong-password', password: 'brand-new-password-1' }, '/platform/operators');
  assert.match((await op.page('/platform/operators')).text, /current password is not right/);
  await op.form('/platform/operators/me/password', { current: 'operator-password-123', password: 'short' }, '/platform/operators');
  assert.ok(await bcrypt.compare('operator-password-123', (await db.platformOperator.findUnique({ where: { id: me.id } })).passwordHash), 'too short: unchanged');
  await op.form('/platform/operators/me/password', { current: 'operator-password-123', password: 'brand-new-password-1' }, '/platform/operators');
  assert.ok(await bcrypt.compare('brand-new-password-1', (await db.platformOperator.findUnique({ where: { id: me.id } })).passwordHash));
  assert.strictEqual((await client().page('/platform/operators')).location, '/platform/login');
});
