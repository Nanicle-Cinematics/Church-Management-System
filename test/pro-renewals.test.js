'use strict';
// Pro renewals (lib/pro-renewals.js, Platform › Pro renewals): reminders 14
// and 3 days before a Pro plan ends and when it lapses, each once per end
// date; the portal list; and extending a plan by months.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const OTPAuth = require('otpauth');
const { createTenantApp } = require('../lib/tenant-http');
const { db } = require('../lib/tenant');
const { signupChurch } = require('../lib/provision');
const { createTotpSecret, createRecoveryCodes } = require('../lib/mfa');
const renewals = require('../lib/pro-renewals');

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
  const email = unique('op-renew');
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

test('reminder stages: 14 days, 3 days, and lapsed (for a week)', () => {
  const now = new Date('2026-10-15T12:00:00Z');
  const at = (days) => new Date(now.getTime() + days * DAY);
  assert.strictEqual(renewals.dueStage(at(20), now), null);
  assert.strictEqual(renewals.dueStage(at(14), now), '14d');
  assert.strictEqual(renewals.dueStage(at(3), now), '3d');
  assert.strictEqual(renewals.dueStage(at(-1), now), 'lapsed');
  assert.strictEqual(renewals.dueStage(at(-8), now), null);
  assert.strictEqual(renewals.extendedUntil(at(10), 3, now).getTime(), at(100).getTime(), 'from the current end');
  assert.strictEqual(renewals.extendedUntil(at(-5), 1, now).getTime(), at(30).getTime(), 'from today once lapsed');
  assert.doesNotMatch(renewals.reminderText({ name: 'X', proUntil: at(3) }, '3d'), /reply/i, 'a sender name cannot receive replies');
});

test('each reminder goes once per end date; extending starts them afresh', async () => {
  const now = new Date();
  const churchId = await proChurch('renew-once', new Date(now.getTime() + 10 * DAY));
  const mine = (sent) => sent.filter((s) => s.churchId === churchId).map((s) => s.stage);

  assert.deepStrictEqual(mine(await renewals.sendProRenewalReminders(now)), ['14d']);
  assert.deepStrictEqual(mine(await renewals.sendProRenewalReminders(now)), [], 'not twice');
  const mail = await db.emailLog.findFirst({ where: { churchId }, orderBy: { id: 'desc' } });
  assert.ok(mail, 'the admin was emailed (a dry run under the test runner)');
  assert.match(mail.subject, /Pro plan ends on/);

  assert.deepStrictEqual(mine(await renewals.sendProRenewalReminders(new Date(now.getTime() + 8 * DAY))), ['3d']);
  assert.deepStrictEqual(mine(await renewals.sendProRenewalReminders(new Date(now.getTime() + 11 * DAY))), ['lapsed']);
  assert.deepStrictEqual(mine(await renewals.sendProRenewalReminders(new Date(now.getTime() + 12 * DAY))), []);

  // A new end date: reminders begin again.
  await db.church.update({ where: { id: churchId }, data: { proUntil: new Date(now.getTime() + 13 * DAY) } });
  assert.deepStrictEqual(mine(await renewals.sendProRenewalReminders(now)), ['14d']);

  // Deleted or suspended churches are left alone.
  await db.church.update({ where: { id: churchId }, data: { suspendedAt: new Date(), proUntil: new Date(now.getTime() + 2 * DAY) } });
  assert.deepStrictEqual(mine(await renewals.sendProRenewalReminders(now)), []);
});

test('the portal lists renewals and extends a plan from its current end', async () => {
  const now = Date.now();
  const soon = await proChurch('renew-soon', new Date(now + 5 * DAY));
  const later = await proChurch('renew-later', new Date(now + 90 * DAY));
  const op = await signedInOperator();

  const portal = (await op.page('/platform')).text;
  assert.match(portal, /Pro renewals/);
  assert.match(portal, new RegExp(`/platform/churches/${soon}/extend`));
  assert.doesNotMatch(portal, new RegExp(`/platform/churches/${later}/extend`), 'ends in 90 days: not listed');

  const before = (await db.church.findUnique({ where: { id: soon } })).proUntil;
  const res = await op.form(`/platform/churches/${soon}/extend`, { months: '3' }, '/platform');
  assert.strictEqual(res.status, 302);
  const after = await db.church.findUnique({ where: { id: soon } });
  assert.strictEqual(after.proUntil.getTime(), before.getTime() + 90 * DAY);
  assert.strictEqual(after.plan, 'pro');
  assert.ok(await db.platformAuditLog.findFirst({ where: { churchId: soon, event: 'platform.plan_extended' } }));

  await op.form(`/platform/churches/${soon}/extend`, { months: '7' }, '/platform');
  assert.strictEqual((await db.church.findUnique({ where: { id: soon } })).proUntil.getTime(), after.proUntil.getTime(), 'only 1, 3, 6 or 12');
});
