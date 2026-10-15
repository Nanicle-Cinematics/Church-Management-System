'use strict';
// Platform › Errors (lib/error-groups.js): the error log grouped by method,
// path and message with ids and numbers taken out; Mark fixed; a fixed fault
// that happens again comes back as open, flagged.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const OTPAuth = require('otpauth');
const { createTenantApp } = require('../lib/tenant-http');
const { db } = require('../lib/tenant');
const { signupChurch } = require('../lib/provision');
const { createTotpSecret, createRecoveryCodes } = require('../lib/mfa');
const { errorGroups, resolveGroup, normalizePath, normalizeMessage } = require('../lib/error-groups');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const DAY = 24 * 60 * 60 * 1000;
// Letters only: digits are folded into N by the grouping.
const TAG = `Fault${Array.from({ length: 8 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('')}`;
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
  await db.errorLog.deleteMany({ where: { message: { startsWith: TAG } } });
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
  const email = unique('op-errors');
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

test('paths and messages lose their ids and numbers', () => {
  assert.strictEqual(normalizePath('/members/123/edit?x=1'), '/members/:id/edit');
  assert.strictEqual(normalizePath('/platform/churches/cmgabcdefghijklmnopqrstu'), '/platform/churches/:id');
  assert.strictEqual(normalizeMessage('Member 123 not found for "Ama"\nat foo'), 'Member N not found for …');
});

const mine = (groups) => groups.filter((g) => g.message.startsWith(TAG));
const log = (path, message, extra = {}) => db.errorLog.create({ data: { method: 'GET', path, message, ...extra } });

test('one fault on many records is one group; mark fixed; it comes back if it recurs', async () => {
  await log('/members/1', `${TAG} member 1 missing`);
  await log('/members/22', `${TAG} member 22 missing`);
  await log('/members/333', `${TAG} member 333 missing`);
  await log('/events/9', `${TAG} event broke`);
  let open = mine(await errorGroups());
  assert.strictEqual(open.length, 2);
  const members = open.find((g) => g.path === '/members/:id');
  assert.strictEqual(members.open, 3);

  assert.strictEqual(await resolveGroup(members.key, 'op@example.test'), 3);
  open = mine(await errorGroups());
  assert.deepStrictEqual(open.map((g) => g.path), ['/events/:id']);
  const fixed = mine(await errorGroups({ show: 'fixed' }));
  assert.strictEqual(fixed[0].resolvedBy, 'op@example.test');

  await log('/members/4444', `${TAG} member 4444 missing`);
  const back = mine(await errorGroups()).find((g) => g.path === '/members/:id');
  assert.deepStrictEqual([back.open, back.cameBack], [1, true]);
});

test('the Errors tab, and Mark fixed from it', async () => {
  await log('/finance/7', `${TAG} ledger out of balance`);
  const op = await signedInOperator();
  const page = await op.page('/platform/errors');
  assert.strictEqual(page.status, 200);
  assert.match(page.text, /aria-current="page">Errors</);
  assert.match(page.text, new RegExp(`${TAG} ledger out of balance`));
  const key = (await errorGroups()).find((g) => g.message.startsWith(`${TAG} ledger`)).key;
  await op.form('/platform/errors/resolve', { key }, '/platform/errors');
  assert.strictEqual(await db.errorLog.count({ where: { message: { startsWith: `${TAG} ledger` }, resolvedAt: null } }), 0);
  assert.match((await op.page('/platform/errors?show=fixed')).text, new RegExp(`${TAG} ledger`));
  assert.strictEqual((await client().page('/platform/errors')).location, '/platform/login');
});
