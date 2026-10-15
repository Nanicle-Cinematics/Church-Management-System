'use strict';
// Platform › Churches at risk (lib/church-health.js): last sign-in (from the
// security log, so older history counts), last activity, setup, the quiet
// and never-started lists, and users.last_login_at stamped at sign-in.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const OTPAuth = require('otpauth');
const { createTenantApp } = require('../lib/tenant-http');
const { db } = require('../lib/tenant');
const { signupChurch } = require('../lib/provision');
const { createTotpSecret, createRecoveryCodes } = require('../lib/mfa');
const { healthReport } = require('../lib/church-health');

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
  const email = unique('op-health');
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

const daysAgo = (n) => new Date(Date.now() - n * DAY);

async function church(tag, { age, members = 0, signedInDaysAgo = null, activeDaysAgo = null }) {
  const email = unique(tag);
  const { church: c } = await signupChurch({ churchName: `${tag} Church`, name: 'Owner', email, password: 'password123' });
  churchIds.push(c.id);
  await db.church.update({ where: { id: c.id }, data: { createdAt: daysAgo(age) } });
  if (members) await db.member.createMany({ data: Array.from({ length: members }, (_, i) => ({ churchId: c.id, firstName: `M${i}`, lastName: tag })) });
  if (signedInDaysAgo !== null) await db.securityAuditLog.create({ data: { churchId: c.id, event: 'auth.login_succeeded', occurredAt: daysAgo(signedInDaysAgo) } });
  if (activeDaysAgo !== null) await db.activityLog.create({ data: { churchId: c.id, kind: 'member_added', description: 'x', occurredAt: daysAgo(activeDaysAgo) } });
  return { id: c.id, email };
}

test('quiet, never started, and fine', async () => {
  const quiet = await church('health-quiet', { age: 90, members: 20, signedInDaysAgo: 45, activeDaysAgo: 40 });
  const stalled = await church('health-stalled', { age: 10, members: 1, signedInDaysAgo: 9 });
  const fresh = await church('health-fresh', { age: 2 });
  const busy = await church('health-busy', { age: 90, members: 30, signedInDaysAgo: 50, activeDaysAgo: 1 });

  const report = new Map((await healthReport()).map((r) => [r.id, r]));
  const q = report.get(quiet.id);
  assert.deepStrictEqual([q.inactive, q.neverStarted, q.idleDays], [true, false, 40]);
  assert.strictEqual(q.members, 20);
  assert.match(q.owner.email, /health-quiet/);
  assert.deepStrictEqual([report.get(stalled.id).inactive, report.get(stalled.id).neverStarted], [false, true]);
  assert.deepStrictEqual([report.get(fresh.id).inactive, report.get(fresh.id).neverStarted], [false, false], 'too new to judge');
  assert.deepStrictEqual([report.get(busy.id).inactive, report.get(busy.id).neverStarted], [false, false], 'activity counts as use');

  await db.church.update({ where: { id: quiet.id }, data: { suspendedAt: new Date() } });
  assert.ok(!(await healthReport()).some((r) => r.id === quiet.id), 'suspended churches are left out');
});

test('signing in stamps the user\'s last sign-in', async () => {
  const c = await church('health-login', { age: 1 });
  assert.strictEqual((await db.user.findFirst({ where: { churchId: c.id } })).lastLoginAt, null);
  const res = await fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: c.email, password: 'password123' }) });
  assert.strictEqual(res.status, 200);
  const user = await db.user.findFirst({ where: { churchId: c.id } });
  assert.ok(user.lastLoginAt && Date.now() - user.lastLoginAt < 60000);
});

test('the Churches at risk tab, and the count on Overview', async () => {
  const stalled = await church('health-page', { age: 20, members: 0 });
  const op = await signedInOperator();
  const page = await op.page('/platform/health');
  assert.strictEqual(page.status, 200);
  assert.match(page.text, /aria-current="page">Churches at risk</);
  assert.match(page.text, /Never got started/);
  assert.match(page.text, new RegExp(`/platform/churches/${stalled.id}`));
  assert.match(page.text, /mailto:health-page/);
  assert.match((await op.page('/platform')).text, /Churches at risk<\/a>/);
  assert.match((await op.page(`/platform/churches/${stalled.id}`)).text, /Last sign-in/);
  assert.strictEqual((await client().page('/platform/health')).location, '/platform/login');
});
