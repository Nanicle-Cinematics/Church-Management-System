'use strict';
// "View as church" (lib/support-view.js): only once a church admin allows
// support access; read-only (no changes, no exports, a read-only db); ends
// when access is turned off, runs out or the operator ends it; every step in
// the church's own security log.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const OTPAuth = require('otpauth');
const { createTenantApp } = require('../lib/tenant-http');
const { db } = require('../lib/tenant');
const { signupChurch } = require('../lib/provision');
const { createTotpSecret, createRecoveryCodes } = require('../lib/mfa');
const { readOnlyTenantDb } = require('../lib/tenant');

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
  const email = unique('op-view');
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

async function churchAdmin() {
  const email = unique('view-admin');
  const { church } = await signupChurch({ churchName: 'Viewed Church', name: 'Owner', email, password: 'Tr0ubadour-7!' });
  churchIds.push(church.id);
  const c = client();
  const res = await fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'Tr0ubadour-7!' }) });
  c.cookie = res.headers.getSetCookie().find((x) => x.startsWith('connect.sid=')).split(';')[0];
  // Reuse the cookie through the helper's form() by priming it with a page load.
  const page = (p) => fetch(base + p, { headers: { cookie: c.cookie }, redirect: 'manual' }).then(async (r) => ({ status: r.status, location: r.headers.get('location'), text: await r.text() }));
  const form = async (p, fields, from = p) => {
    const csrf = ((await page(from)).text.match(/name="_csrf" value="([^"]*)"/) || [])[1] || '';
    const r = await fetch(base + p, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: c.cookie }, body: new URLSearchParams({ ...fields, _csrf: csrf }).toString() });
    return { status: r.status, location: r.headers.get('location'), text: await r.text() };
  };
  return { churchId: church.id, page, form };
}

test('the read-only database refuses writes', async () => {
  const ro = readOnlyTenantDb('no-such-church');
  await assert.rejects(() => ro.member.create({ data: { firstName: 'A', lastName: 'B' } }), /Read-only support view/);
  await assert.rejects(() => ro.member.deleteMany({}), /Read-only support view/);
  assert.deepStrictEqual(await ro.member.findMany({}), [], 'reads still work');
});

test('no view until the church allows it; then read-only, logged, and over when access is turned off', async () => {
  const admin = await churchAdmin();
  const op = await signedInOperator();
  const consolePage = `/platform/churches/${admin.churchId}`;

  assert.match((await op.page(consolePage)).text, /not allowed/);
  await op.form(`${consolePage}/view`, {}, consolePage);
  assert.match((await op.page(consolePage)).text, /has not turned on support access/);
  assert.notStrictEqual((await op.page('/')).text.includes('Support view, read-only'), true);

  // The admin allows it for 24 hours.
  assert.match((await admin.page('/settings')).text, /Support access/);
  await admin.form('/settings/support-access', { hours: '24' }, '/settings');
  const church = await db.church.findUnique({ where: { id: admin.churchId } });
  assert.ok(church.supportAccessUntil > new Date(Date.now() + 23 * 3600 * 1000));
  assert.ok(await db.securityAuditLog.findFirst({ where: { churchId: admin.churchId, event: 'support.access_granted' } }));

  // The operator views, read-only.
  assert.match((await op.page(consolePage)).text, /View as church \(read-only\)/);
  const started = await op.form(`${consolePage}/view`, {}, consolePage);
  assert.strictEqual(started.location, '/');
  const home = await op.page('/');
  assert.strictEqual(home.status, 200);
  assert.match(home.text, /Support view, read-only/);
  assert.match(home.text, /Viewed Church/);
  assert.ok(await db.securityAuditLog.findFirst({ where: { churchId: admin.churchId, event: 'support.view_started' } }));

  const before = await db.member.count({ where: { churchId: admin.churchId } });
  const add = await op.form('/members', { firstName: 'Sneaky', lastName: 'Write', mobilePhone: '0244000999', gender: 'M', membershipStatus: 'MEMBER', preferredChannel: 'NONE' }, '/members/new');
  assert.strictEqual(add.status, 403);
  assert.match(add.text, /read-only support view/);
  assert.strictEqual(await db.member.count({ where: { churchId: admin.churchId } }), before);
  assert.strictEqual((await op.page('/members/export.csv')).status, 403, 'no exports');
  assert.strictEqual((await op.page('/settings/export.json')).status, 403);
  assert.strictEqual((await op.page('/members')).status, 200, 'but pages can be read');

  // The admin turns it off: the view is over at the next request.
  await admin.form('/settings/support-access', { hours: 'off' }, '/settings');
  assert.doesNotMatch((await op.page('/')).text, /Support view, read-only/);
  assert.ok(await db.securityAuditLog.findFirst({ where: { churchId: admin.churchId, event: 'support.view_ended' } }));
  assert.match((await admin.page('/settings')).text, /started viewing the app, read-only/, 'the visit is listed for the church');
});

test('End returns to the console', async () => {
  const admin = await churchAdmin();
  await admin.form('/settings/support-access', { hours: '1' }, '/settings');
  const op = await signedInOperator();
  await op.form(`/platform/churches/${admin.churchId}/view`, {}, `/platform/churches/${admin.churchId}`);
  const ended = await op.form('/support/end', {}, '/');
  assert.strictEqual(ended.location, `/platform/churches/${admin.churchId}`);
  assert.doesNotMatch((await op.page('/')).text, /Support view, read-only/);
  assert.strictEqual((await op.page('/platform')).status, 200, 'still signed in to the console');
});
