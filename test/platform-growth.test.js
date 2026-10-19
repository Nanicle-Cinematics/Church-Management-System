'use strict';
// The Overview's growth chart (lib/platform-growth.js): sign-ups, Pro
// upgrades (from the upgrade event or pro_since, once per church per month)
// and deletions for each of the last 12 months.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const OTPAuth = require('otpauth');
const { createTenantApp } = require('../lib/tenant-http');
const { db } = require('../lib/tenant');
const { signupChurch } = require('../lib/provision');
const { createTotpSecret, createRecoveryCodes } = require('../lib/mfa');
const { growthByMonth } = require('../lib/platform-growth');

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
  const email = unique('op-growth');
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

const monthsAgo = (n, day = 10) => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - n, day, 12)); };
const byMonth = (rows) => Object.fromEntries(rows.map((r) => [r.month, r]));

test('sign-ups, upgrades (event or pro_since, once per church a month) and deletions', async () => {
  const before = byMonth(await growthByMonth());
  const add = async (tag, createdAt) => {
    const { church } = await signupChurch({ churchName: `${tag} Church`, name: 'Owner', email: unique(tag), password: 'Tr0ubadour-7!' });
    churchIds.push(church.id);
    await db.church.update({ where: { id: church.id }, data: { createdAt } });
    return church.id;
  };
  const a = await add('growth-a', monthsAgo(3));
  const b = await add('growth-b', monthsAgo(3));
  await add('growth-c', monthsAgo(1));
  // a upgraded two months ago: an event and pro_since in the same month count once.
  await db.securityAuditLog.create({ data: { churchId: a, event: 'platform.plan_upgraded', occurredAt: monthsAgo(2) } });
  await db.church.update({ where: { id: a }, data: { plan: 'pro', proSince: monthsAgo(2, 15) } });
  // b: only pro_since (an upgrade from before the event existed), then deleted last month.
  await db.church.update({ where: { id: b }, data: { plan: 'pro', proSince: monthsAgo(2, 20), deletedAt: monthsAgo(1) } });
  await db.church.update({ where: { id: b }, data: { createdAt: monthsAgo(3) } });

  const after = byMonth(await growthByMonth());
  const m = (n) => { const d = monthsAgo(n); return d.toISOString().slice(0, 7); };
  const delta = (month, key) => after[month][key] - before[month][key];
  assert.strictEqual(Object.keys(after).length, 12);
  assert.strictEqual(delta(m(3), 'signups'), 2);
  assert.strictEqual(delta(m(1), 'signups'), 1);
  assert.strictEqual(delta(m(2), 'upgrades'), 2, 'a once (event + pro_since), b once (pro_since)');
  assert.strictEqual(delta(m(1), 'deleted'), 1);
});

test('the Overview shows the growth chart', async () => {
  const op = await signedInOperator();
  const page = (await op.page('/platform')).text;
  assert.match(page, /Growth · last 12 months/);
  assert.match(page, /Pro upgrades/);
});
