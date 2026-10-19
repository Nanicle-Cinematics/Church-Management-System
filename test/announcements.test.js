'use strict';
// Platform announcements (lib/announcements.js, Platform › Announcements):
// a notice on every signed-in church page while it runs; scheduled, ended
// and deleted ones are not shown; optionally emailed to church admins.
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
const TAG = `Notice ${process.pid}-${Date.now()}`;
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
  await db.platformAnnouncement.deleteMany({ where: { message: { startsWith: TAG } } });
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
  const email = unique('op-ann');
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

const local = (d) => new Date(d).toISOString().slice(0, 16);

async function churchUser() {
  const email = unique('ann-church');
  const { church } = await signupChurch({ churchName: 'Notice Church', name: 'Owner', email, password: 'Tr0ubadour-7!' });
  churchIds.push(church.id);
  const res = await fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'Tr0ubadour-7!' }) });
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith('connect.sid=')).split(';')[0];
  return (p) => fetch(base + p, { headers: { cookie } }).then((r) => r.text());
}

test('a running notice shows on church pages; scheduled, ended and deleted ones do not', async () => {
  const op = await signedInOperator();
  const view = await churchUser();
  const now = Date.now();

  await op.form('/platform/announcements', { message: `${TAG} running`, startsAt: local(now - 60000), endsAt: local(now + DAY), level: 'warning' }, '/platform/announcements');
  await op.form('/platform/announcements', { message: `${TAG} later`, startsAt: local(now + 2 * DAY), endsAt: '' }, '/platform/announcements');
  await op.form('/platform/announcements', { message: `${TAG} backwards`, startsAt: local(now), endsAt: local(now - DAY) }, '/platform/announcements');
  assert.strictEqual(await db.platformAnnouncement.count({ where: { message: `${TAG} backwards` } }), 0, 'an end before the start is refused');

  let page = await view('/');
  assert.match(page, new RegExp(`class="pc-notice pc-notice-warning"[^>]*><span>${TAG} running</span>`));
  assert.doesNotMatch(page, new RegExp(`${TAG} later`), 'not yet');
  assert.match((await op.page('/platform/announcements')).text, /scheduled/);

  const running = await db.platformAnnouncement.findFirst({ where: { message: `${TAG} running` } });
  await op.form(`/platform/announcements/${running.id}/end`, {}, '/platform/announcements');
  page = await view('/');
  assert.doesNotMatch(page, new RegExp(`${TAG} running`), 'ended');

  const later = await db.platformAnnouncement.findFirst({ where: { message: `${TAG} later` } });
  await op.form(`/platform/announcements/${later.id}/delete`, {}, '/platform/announcements');
  assert.strictEqual(await db.platformAnnouncement.count({ where: { id: later.id } }), 0);
  assert.doesNotMatch((await fetch(`${base}/login`).then((r) => r.text())), /pc-notice/, 'not on signed-out pages');
});

test('emailing a notice to the admins is recorded', async () => {
  const op = await signedInOperator();
  await churchUser();
  await op.form('/platform/announcements', { message: `${TAG} emailed`, startsAt: local(Date.now()), endsAt: '', email: '1' }, '/platform/announcements');
  const id = (await db.platformAnnouncement.findFirst({ where: { message: `${TAG} emailed` } })).id;
  for (let i = 0; i < 40 && !(await db.platformAnnouncement.findUnique({ where: { id } })).emailedAt; i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok((await db.platformAnnouncement.findUnique({ where: { id } })).emailedAt, 'sent in the background (a dry run here)');
  assert.ok(await db.platformAuditLog.findFirst({ where: { event: 'platform.announcement_created', subject: { startsWith: TAG } } }));
});
