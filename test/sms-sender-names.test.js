'use strict';
// SMS through Arkesel or mNotify (SMS_PROVIDER), and each church's own sender
// name: an admin asks for it under Communications › SMS delivery, the
// platform operator approves or rejects it, and only an approved name is
// used on the church's texts (lib/delivery.js smsSenderFor).
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const OTPAuth = require('otpauth');
const { createTenantApp } = require('../lib/tenant-http');
const { db } = require('../lib/tenant');
const { createTotpSecret, createRecoveryCodes } = require('../lib/mfa');
const delivery = require('../lib/delivery');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const PASSWORD = 'operator-password-123';
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
  await db.activityLog.deleteMany({ where });
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

function client() {
  let cookie;
  const remember = (res) => {
    for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) if (c.startsWith('connect.sid=')) cookie = c.split(';')[0];
  };
  return {
    async json(p, body) {
      const res = await fetch(base + p, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
      remember(res);
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    },
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

async function newChurch(tag) {
  const c = client();
  const res = await c.json('/signup', { churchName: `${tag} Church`, name: 'Owner', email: unique(tag), password: 'password123' });
  assert.strictEqual(res.status, 201);
  churchIds.push(res.body.church.id);
  return { c, churchId: res.body.church.id };
}

async function signedInOperator() {
  const email = unique('op-sms');
  const totp = createTotpSecret(email);
  const row = await db.platformOperator.create({ data: {
    email, passwordHash: await bcrypt.hash(PASSWORD, 4),
    totpEnabled: true, totpSecret: totp.secret, totpRecoveryCodes: createRecoveryCodes().serialized,
  } });
  operatorIds.push(row.id);
  const c = client();
  assert.strictEqual((await c.form('/platform/login', { email, password: PASSWORD })).location, '/platform/login/mfa');
  const code = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(totp.secret), digits: 6, period: 30 }).generate();
  assert.strictEqual((await c.form('/platform/login/mfa', { code }, '/platform/login/mfa')).location, '/platform');
  return c;
}

const SETTINGS = '/communications/email-settings';

test('only an approved name is used; everything else falls back to the default', async () => {
  const fallback = delivery.smsDeliveryInfo().defaultSender;
  assert.strictEqual(await delivery.smsSenderFor({ id: 'x', smsSenderId: 'DUNWELL', smsSenderStatus: 'APPROVED' }), 'DUNWELL');
  for (const status of ['PENDING', 'REJECTED', null]) {
    assert.strictEqual(await delivery.smsSenderFor({ id: 'x', smsSenderId: 'DUNWELL', smsSenderStatus: status }), fallback);
  }
  assert.strictEqual(await delivery.smsSenderFor({ id: 'x', smsSenderId: 'Bad name!', smsSenderStatus: 'APPROVED' }), fallback);
  assert.strictEqual(await delivery.smsSenderFor(null), fallback);
  const r = await delivery.sendSmsBatch(['+233244127781'], 'hello', { sender: 'DUNWELL' });
  assert.strictEqual(r.dryRun, true, 'never a real text under the test runner');
});

test('an admin asks for a sender name; the operator approves it; the church\'s texts then use it', async () => {
  const { c, churchId } = await newChurch('sms-sender');
  const page = await c.page(SETTINGS);
  assert.strictEqual(page.status, 200);
  assert.match(page.text, /SMS delivery/);
  assert.match(page.text, /action="\/communications\/sms-sender"/);
  assert.match(page.text, /action="\/communications\/sms-test"/);

  // Names the networks would refuse are refused here.
  for (const bad of ['DW', 'Dunwell Methodist', 'DUN-WELL', 'TWELVECHARSX']) {
    await c.form('/communications/sms-sender', { senderId: bad }, SETTINGS);
  }
  assert.strictEqual((await db.church.findUnique({ where: { id: churchId } })).smsSenderId, null);

  await c.form('/communications/sms-sender', { senderId: 'DUNWELL' }, SETTINGS);
  let church = await db.church.findUnique({ where: { id: churchId } });
  assert.deepStrictEqual([church.smsSenderId, church.smsSenderStatus], ['DUNWELL', 'PENDING']);
  assert.match((await c.page(SETTINGS)).text, /awaiting approval/);
  assert.notStrictEqual(await delivery.smsSenderFor(churchId), 'DUNWELL', 'not used before approval');

  const op = await signedInOperator();
  const portal = await op.page('/platform');
  assert.match(portal.text, /SMS sender names to approve/);
  assert.match(portal.text, new RegExp(`/platform/churches/${churchId}/sms-sender`));

  // A stale approval (the church changed its request since) is refused.
  await op.form(`/platform/churches/${churchId}/sms-sender`, { action: 'approve', senderId: 'OLDNAME' }, '/platform');
  assert.strictEqual((await db.church.findUnique({ where: { id: churchId } })).smsSenderStatus, 'PENDING');

  await op.form(`/platform/churches/${churchId}/sms-sender`, { action: 'approve', senderId: 'DUNWELL' }, '/platform');
  church = await db.church.findUnique({ where: { id: churchId } });
  assert.strictEqual(church.smsSenderStatus, 'APPROVED');
  assert.strictEqual(await delivery.smsSenderFor(churchId), 'DUNWELL');
  assert.match((await c.page(SETTINGS)).text, /Your texts are sent as <b>DUNWELL<\/b>/);
  assert.ok(await db.platformAuditLog.findFirst({ where: { churchId, event: 'platform.sms_sender_approved' } }));

  // Asking for a new name goes back to waiting, and the default is used meanwhile.
  await c.form('/communications/sms-sender', { senderId: 'DUNWELLMC' }, SETTINGS);
  assert.strictEqual((await db.church.findUnique({ where: { id: churchId } })).smsSenderStatus, 'PENDING');
  assert.notStrictEqual(await delivery.smsSenderFor(churchId), 'DUNWELLMC');

  // Rejected, with a reason the church sees.
  await op.form(`/platform/churches/${churchId}/sms-sender`, { action: 'reject', senderId: 'DUNWELLMC', note: 'Too close to another church' }, '/platform');
  church = await db.church.findUnique({ where: { id: churchId } });
  assert.strictEqual(church.smsSenderStatus, 'REJECTED');
  const after = (await c.page(SETTINGS)).text;
  assert.match(after, /not approved/);
  assert.match(after, /Too close to another church/);

  // And removed.
  await c.form('/communications/sms-sender', { remove: '1' }, SETTINGS);
  church = await db.church.findUnique({ where: { id: churchId } });
  assert.deepStrictEqual([church.smsSenderId, church.smsSenderStatus], [null, null]);
});

test('the test SMS answers in words, and only admins can change the sender name', async () => {
  const { c, churchId } = await newChurch('sms-test');
  const sent = await c.form('/communications/sms-test', { phone: '024 412 7781' }, SETTINGS);
  assert.strictEqual(sent.status, 302);
  assert.match((await c.page(SETTINGS)).text, /Not sent: Running under the test runner/);
  await c.form('/communications/sms-test', { phone: 'not a number' }, SETTINGS);
  assert.match((await c.page(SETTINGS)).text, /Enter a valid phone number/);

  const editorEmail = unique('sms-editor');
  await db.user.create({ data: { churchId, username: `sms-editor-${Date.now()}`, email: editorEmail, passwordHash: await bcrypt.hash('password123', 4), role: 'EDITOR', financeRole: 'NONE' } });
  const editor = client();
  assert.strictEqual((await editor.json('/login', { email: editorEmail, password: 'password123' })).status, 200);
  const refused = await editor.form('/communications/sms-sender', { senderId: 'HIJACK' }, '/members');
  assert.strictEqual(refused.status, 403);
  assert.strictEqual((await db.church.findUnique({ where: { id: churchId } })).smsSenderId, null);
});
