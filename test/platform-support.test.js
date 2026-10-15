'use strict';
// Platform support tools (routes-pg-html/platform-support.js): a reset link
// by email, text or on screen; unlocking; resending verification; changing
// how someone signs in; each written to the church's own security log.
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
let server, base;

test.before(async () => {
  const app = createTenantApp({ pool });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  server.close();
  const where = { churchId: { in: churchIds } };
  await db.passwordResetToken.deleteMany({ where });
  await db.emailVerificationToken.deleteMany({ where });
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
  const email = unique('op-support');
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

async function setup() {
  const ownerEmail = unique('support-owner');
  const { church } = await signupChurch({ churchName: 'Support Church', name: 'Owner', email: ownerEmail, password: 'password123' });
  churchIds.push(church.id);
  const owner = await db.user.findFirst({ where: { churchId: church.id } });
  const phoneUser = await db.user.create({ data: { churchId: church.id, username: `phone-${Date.now()}`, phone: `+23324${String(Date.now()).slice(-7)}`, passwordHash: await bcrypt.hash('password123', 4), role: 'EDITOR' } });
  return { churchId: church.id, owner, phoneUser };
}

test('a reset link: emailed, texted, or shown to the operator, and it works', async () => {
  const { churchId, owner, phoneUser } = await setup();
  const op = await signedInOperator();
  const page = `/platform/churches/${churchId}`;
  assert.match((await op.page(page)).text, /<details class="op-help">/);

  await op.form(`${page}/users/${owner.id}/reset`, { via: 'email' }, page);
  const mail = await db.emailLog.findFirst({ where: { churchId, subject: 'Reset your Church Manager password' } });
  assert.ok(mail && mail.recipient === owner.email);

  await op.form(`${page}/users/${phoneUser.id}/reset`, { via: 'email' }, page);
  assert.match((await op.page(page)).text, /This user has no email/);

  await op.form(`${page}/users/${phoneUser.id}/reset`, { via: 'show' }, page);
  const shown = (await op.page(page)).text;
  const link = (shown.match(/\/reset-password\/([0-9a-f]{64})/) || [])[1];
  assert.ok(link, 'the link is shown once');
  assert.strictEqual((await client().page(`/reset-password/${link}`)).status, 200, 'and it works');

  await op.form(`${page}/users/${phoneUser.id}/reset`, { via: 'sms' }, page);
  assert.match((await op.page(page)).text, /The text was not sent: Running under the test runner/);

  const events = await db.securityAuditLog.findMany({ where: { churchId, event: 'support.password_reset_link' } });
  assert.strictEqual(events.length, 3, 'each one in the church\'s own security log');
  assert.ok(events.every((e) => e.subject.startsWith('Platform support:')));
});

test('unlock, resend verification, and change how someone signs in', async () => {
  const { churchId, owner, phoneUser } = await setup();
  const op = await signedInOperator();
  const page = `/platform/churches/${churchId}`;

  await db.user.update({ where: { id: owner.id }, data: { failedAttempts: 5, lockedUntil: new Date(Date.now() + 600000), emailVerifiedAt: null } });
  assert.match((await op.page(page)).text, /pill-failed">locked/);
  await op.form(`${page}/users/${owner.id}/unlock`, {}, page);
  let u = await db.user.findUnique({ where: { id: owner.id } });
  assert.deepStrictEqual([u.failedAttempts, u.lockedUntil], [0, null]);

  await op.form(`${page}/users/${owner.id}/verify`, {}, page);
  assert.ok(await db.emailLog.findFirst({ where: { churchId, subject: 'Verify your Church Manager email' } }));

  const newEmail = unique('support-new');
  await op.form(`${page}/users/${phoneUser.id}/sign-in`, { email: newEmail, phone: phoneUser.phone }, page);
  u = await db.user.findUnique({ where: { id: phoneUser.id } });
  assert.strictEqual(u.email, newEmail);
  assert.ok(u.emailVerifiedAt, 'an operator-set email counts as verified');

  await op.form(`${page}/users/${phoneUser.id}/sign-in`, { email: owner.email, phone: '' }, page);
  assert.strictEqual((await db.user.findUnique({ where: { id: phoneUser.id } })).email, newEmail, 'someone else\'s email is refused');

  // A user of another church cannot be reached through this church's page.
  const other = await setup();
  await op.form(`${page}/users/${other.owner.id}/unlock`, {}, page);
  assert.match((await op.page(page)).text, /That user is not in this church/);
  assert.ok(await db.securityAuditLog.findFirst({ where: { churchId, event: 'support.login_changed' } }));
});
