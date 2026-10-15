'use strict';
// Trial enquiries: the marketing site's demo form (POST /enquiry, public and
// cross-site: no CSRF token, a honeypot, 5 an hour per address) and the
// operator's inbox (Platform › Trial enquiries).
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
const TAG = `Enquiry ${process.pid}-${Date.now()}`;
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
  await db.trialSignup.deleteMany({ where: { churchName: { startsWith: TAG } } });
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
  const email = unique('op-trials');
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

// As the marketing site posts it: a plain form from another origin, no cookie.
const enquire = (fields) => fetch(`${base}/enquiry`, {
  method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded', referer: 'https://mychurchmanager.example/' },
  body: new URLSearchParams(fields).toString(),
}).then(async (r) => ({ status: r.status, text: await r.text() }));

test('the demo form files an enquiry; bots and incomplete forms do not; 5 an hour', async () => {
  const ok = await enquire({ name: 'Ama Owusu', role: 'Secretary', church: `${TAG} Grace Chapel`, denomination: 'Methodist', phone: '024 412 7781', email: 'ama@example.test', city: 'Koforidua', size: '100 – 300', notes: 'Line one\nLine two', website: '' });
  assert.strictEqual(ok.status, 200);
  assert.match(ok.text, /Thank you, Ama Owusu/);
  assert.match(ok.text, /href="https:\/\/mychurchmanager.example\/">Back to the website/);
  const row = await db.trialSignup.findFirst({ where: { churchName: `${TAG} Grace Chapel` } });
  assert.strictEqual(row.status, 'new');
  assert.strictEqual(row.memberCount, '100 – 300');
  assert.strictEqual(row.notes, 'Denomination: Methodist\nCity: Koforidua\nLine one\nLine two');

  const bot = await enquire({ name: 'Bot', church: `${TAG} Spam`, phone: '0244000000', website: 'http://spam.example' });
  assert.strictEqual(bot.status, 200, 'looks accepted to the bot');
  assert.strictEqual(await db.trialSignup.count({ where: { churchName: `${TAG} Spam` } }), 0);

  const missing = await enquire({ name: 'No Phone', church: `${TAG} Missing` });
  assert.strictEqual(missing.status, 400);
  assert.strictEqual(await db.trialSignup.count({ where: { churchName: `${TAG} Missing` } }), 0);

  await enquire({ name: 'Four', church: `${TAG} Four`, phone: '0244000004' });
  await enquire({ name: 'Five', church: `${TAG} Five`, phone: '0244000005' });
  const sixth = await enquire({ name: 'Six', church: `${TAG} Six`, phone: '0244000006' });
  assert.strictEqual(sixth.status, 429);
  assert.strictEqual(await db.trialSignup.count({ where: { churchName: `${TAG} Six` } }), 0);
});

test('the inbox: statuses, notes, linking the church they signed up as', async () => {
  const t = await db.trialSignup.create({ data: { churchName: `${TAG} Bethel`, contactName: 'Kofi', phone: '0244127781', email: 'kofi@example.test', status: 'new' } });
  const { church } = await signupChurch({ churchName: `${TAG} Bethel Church`, name: 'Kofi', email: unique('trial-convert'), password: 'password123' });
  churchIds.push(church.id);
  const op = await signedInOperator();

  const inbox = await op.page('/platform/trials');
  assert.strictEqual(inbox.status, 200);
  assert.match(inbox.text, /aria-current="page">Trial enquiries</);
  assert.match(inbox.text, new RegExp(`id="t${t.id}"`));
  assert.match(inbox.text, /href="https:\/\/wa.me\/233244127781"/);
  assert.match(inbox.text, /mailto:kofi%40example.test\?subject=/);

  await op.form(`/platform/trials/${t.id}`, { status: 'contacted', churchId: '', note: 'Called, demo on Friday' }, '/platform/trials');
  let row = await db.trialSignup.findUnique({ where: { id: t.id } });
  assert.deepStrictEqual([row.status, row.operatorNote], ['contacted', 'Called, demo on Friday']);
  assert.ok(row.contactedAt);

  await op.form(`/platform/trials/${t.id}`, { status: 'contacted', churchId: church.id, note: 'Signed up' }, '/platform/trials');
  row = await db.trialSignup.findUnique({ where: { id: t.id } });
  assert.deepStrictEqual([row.status, row.convertedChurchId], ['converted', church.id], 'linking a church converts it');
  assert.match((await op.page('/platform/trials?status=converted')).text, new RegExp(`/platform/churches/${church.id}`));
  assert.ok(await db.platformAuditLog.findFirst({ where: { event: 'platform.trial_status', subject: { contains: `${TAG} Bethel` } } }));

  assert.strictEqual((await client().page('/platform/trials')).location, '/platform/login');
});
