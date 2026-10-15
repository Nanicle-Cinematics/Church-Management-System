'use strict';
// The platform console (routes-pg/platform.js, routes-pg-html/platform.js)
// sees across every church through the RAW Prisma client, so these tests
// prove the gate: only a platform operator (lib/platform-operators.js), a
// separate account with its own sign-in and mandatory two-factor, gets in.
// No church account does, whatever its role or email.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const OTPAuth = require('otpauth');
const { createTenantApp } = require('../lib/tenant-http');
const { db } = require('../lib/tenant');
const { createTotpSecret, createRecoveryCodes } = require('../lib/mfa');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const createdChurchIds = [];
const createdOperatorIds = [];
const PASSWORD = 'correct horse battery staple';

let server, base, op;
test.before(async () => {
  const app = createTenantApp({ pool });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  op = await newOperator('main');
  op.client = await signedInOperator(op);
});
test.after(async () => {
  server.close();
  if (createdChurchIds.length) {
    const where = { churchId: { in: createdChurchIds } };
    await db.securityAuditLog.deleteMany({ where });
    await db.account.deleteMany({ where });
    await db.user.deleteMany({ where });
    await db.specialCategory.deleteMany({ where });
    await db.serviceType.deleteMany({ where });
    await db.expenseCategory.deleteMany({ where });
    await db.church.deleteMany({ where: { id: { in: createdChurchIds } } });
  }
  await db.platformAuditLog.deleteMany({ where: { operatorId: { in: createdOperatorIds } } });
  await db.platformOperator.deleteMany({ where: { id: { in: createdOperatorIds } } });
  await db.$disconnect();
  await pool.end();
});

function client() {
  let cookie;
  const remember = (res) => {
    const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of set) if (c.startsWith('connect.sid=')) cookie = c.split(';')[0];
  };
  const json = async (method, p, body) => {
    const res = await fetch(base + p, {
      method, redirect: 'manual',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    remember(res);
    const text = await res.text();
    let parsed; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: res.status, body: parsed };
  };
  return {
    get: (p) => json('GET', p),
    post: (p, b) => json('POST', p, b),
    async page(p) {
      const res = await fetch(base + p, { headers: cookie ? { cookie } : {}, redirect: 'manual' });
      remember(res);
      return { status: res.status, location: res.headers.get('location'), text: await res.text() };
    },
    // A real browser form post: fetch a page for its CSRF token first.
    async form(p, fields, from = p) {
      const page = await this.page(from);
      const csrf = (page.text.match(/name="_csrf" value="([^"]*)"/) || [])[1];
      const res = await fetch(base + p, {
        method: 'POST', redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
        body: new URLSearchParams({ ...fields, _csrf: csrf || '' }).toString(),
      });
      remember(res);
      return { status: res.status, location: res.headers.get('location'), text: await res.text() };
    },
  };
}

const unique = (tag) => `${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
const codeFor = (secret) => new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret), digits: 6, period: 30 }).generate();

async function newOperator(tag, { withTotp = true, email = unique(`op-${tag}`) } = {}) {
  const totp = withTotp ? createTotpSecret(email) : null;
  const recovery = withTotp ? createRecoveryCodes() : null;
  const row = await db.platformOperator.create({ data: {
    email, passwordHash: await bcrypt.hash(PASSWORD, 4),
    totpEnabled: withTotp, totpSecret: totp && totp.secret, totpRecoveryCodes: recovery && recovery.serialized,
  } });
  createdOperatorIds.push(row.id);
  return { ...row, secret: totp && totp.secret, recoveryCodes: recovery && recovery.codes };
}

async function signedInOperator(operator) {
  const c = client();
  const pw = await c.form('/platform/login', { email: operator.email, password: PASSWORD });
  assert.strictEqual(pw.location, '/platform/login/mfa');
  const mfa = await c.form('/platform/login/mfa', { code: codeFor(operator.secret) }, '/platform/login/mfa');
  assert.strictEqual(mfa.location, '/platform');
  return c;
}

async function newChurch(tag, email) {
  const c = client();
  const res = await c.post('/signup', { churchName: `${tag} Church`, name: 'Owner', email: email || unique(tag), password: 'password123' });
  assert.strictEqual(res.status, 201);
  createdChurchIds.push(res.body.church.id);
  return { client: c, churchId: res.body.church.id };
}

// ---- the gate ---------------------------------------------------------------

test('signed out, the console redirects to the operator sign-in and the API answers 401', async () => {
  const c = client();
  const page = await c.page('/platform');
  assert.strictEqual(page.status, 302);
  assert.strictEqual(page.location, '/platform/login');
  assert.strictEqual((await c.get('/api/platform/churches')).status, 401);
});

test('a church account never reaches the console, even when an operator has the same email', async () => {
  const email = unique('shared');
  const church = await newChurch('platform-shared', email);
  await newOperator('twin', { email });
  assert.strictEqual((await church.client.get('/api/platform/churches')).status, 401);
  assert.strictEqual((await church.client.page('/platform')).location, '/platform/login');
});

test('an operator session cannot open church pages or the church API', async () => {
  assert.strictEqual((await op.client.get('/api/settings')).status, 401);
  const members = await op.client.page('/members');
  assert.strictEqual(members.status, 302);
  assert.strictEqual(members.location, '/login');
});

test('the church sidebar no longer links to the console', async () => {
  const { client: c } = await newChurch('platform-nav');
  const home = await c.page('/');
  assert.strictEqual(home.status, 200);
  assert.doesNotMatch(home.text, /href="\/platform"/);
});

// ---- sign-in ----------------------------------------------------------------

test('wrong password, unknown email and a disabled operator all get the same refusal', async () => {
  const disabled = await newOperator('disabled');
  await db.platformOperator.update({ where: { id: disabled.id }, data: { disabledAt: new Date() } });
  for (const [email, password] of [[op.email, 'nope nope nope'], [unique('ghost'), PASSWORD], [disabled.email, PASSWORD]]) {
    const res = await client().form('/platform/login', { email, password });
    assert.strictEqual(res.status, 401);
    assert.match(res.text, /Incorrect email or password/);
  }
});

test('the password alone does not open the console; a wrong code is refused', async () => {
  const c = client();
  await c.form('/platform/login', { email: op.email, password: PASSWORD });
  assert.strictEqual((await c.page('/platform')).location, '/platform/login');
  const wrong = await c.form('/platform/login/mfa', { code: '000000' }, '/platform/login/mfa');
  assert.strictEqual(wrong.status, 401);
  assert.strictEqual((await c.page('/platform')).location, '/platform/login');
});

test('a recovery code signs in once', async () => {
  const operator = await newOperator('recovery');
  const [code] = operator.recoveryCodes;
  const first = client();
  await first.form('/platform/login', { email: operator.email, password: PASSWORD });
  assert.strictEqual((await first.form('/platform/login/mfa', { code }, '/platform/login/mfa')).location, '/platform');
  const second = client();
  await second.form('/platform/login', { email: operator.email, password: PASSWORD });
  assert.strictEqual((await second.form('/platform/login/mfa', { code }, '/platform/login/mfa')).status, 401);
});

test('five wrong passwords lock the operator out, even with the right one', async () => {
  const operator = await newOperator('lockout');
  for (let i = 0; i < 5; i++) await client().form('/platform/login', { email: operator.email, password: 'wrong wrong wrong' });
  const res = await client().form('/platform/login', { email: operator.email, password: PASSWORD });
  assert.strictEqual(res.status, 423);
});

test('first sign-in requires setting up two-factor before the console opens', async () => {
  const operator = await newOperator('enrol', { withTotp: false });
  const c = client();
  const pw = await c.form('/platform/login', { email: operator.email, password: PASSWORD });
  assert.strictEqual(pw.location, '/platform/setup-2fa');
  assert.strictEqual((await c.page('/platform')).location, '/platform/login', 'no console before two-factor');

  const setup = await c.page('/platform/setup-2fa');
  const secret = setup.text.match(/class="op-key">([A-Z2-7]+)</)[1];
  assert.strictEqual((await c.form('/platform/setup-2fa', { code: '000000' })).status, 400);
  const done = await c.form('/platform/setup-2fa', { code: codeFor(secret) });
  assert.strictEqual(done.status, 200);
  assert.match(done.text, /recovery codes/i);
  assert.strictEqual((await c.page('/platform')).status, 200);

  const row = await db.platformOperator.findUnique({ where: { id: operator.id } });
  assert.strictEqual(row.totpEnabled, true);
  assert.strictEqual(row.totpSecret, secret);
});

test('signing out ends the console session; sign-ins are audited', async () => {
  const c = await signedInOperator(op);
  assert.strictEqual((await c.page('/platform')).status, 200);
  await c.form('/platform/logout', {}, '/platform');
  assert.strictEqual((await c.page('/platform')).location, '/platform/login');
  const events = await db.platformAuditLog.findMany({ where: { operatorId: op.id }, select: { event: true } });
  assert.ok(events.some((e) => e.event === 'operator.login'));
  assert.ok(events.some((e) => e.event === 'operator.logout'));
});

test('a disabled operator is shut out at their next request', async () => {
  const operator = await newOperator('disable-live');
  const c = await signedInOperator(operator);
  assert.strictEqual((await c.page('/platform')).status, 200);
  await db.platformOperator.update({ where: { id: operator.id }, data: { disabledAt: new Date() } });
  assert.strictEqual((await c.page('/platform')).location, '/platform/login');
});

// ---- console actions --------------------------------------------------------

test('the operator sees every church, with usage counts', async () => {
  const other = await newChurch('platform-list-other');
  const res = await op.client.get('/api/platform/churches');
  assert.strictEqual(res.status, 200);
  const row = res.body.find((c) => c.id === other.churchId);
  assert.ok(row);
  assert.strictEqual(row.userCount, 1);
});

test('the operator can set a church to Pro and back; the church sees it and both audit logs record it', async () => {
  const target = await newChurch('platform-plan');
  const pro = await op.client.post(`/api/platform/churches/${target.churchId}/plan`, { plan: 'pro', months: 12 });
  assert.strictEqual(pro.status, 200);
  assert.strictEqual((await target.client.get('/api/settings')).body.plan.key, 'pro');
  assert.strictEqual((await op.client.post(`/api/platform/churches/${target.churchId}/plan`, { plan: 'free' })).status, 200);

  const churchLog = await db.securityAuditLog.findFirst({ where: { churchId: target.churchId, event: 'platform.plan_upgraded' } });
  assert.ok(churchLog);
  assert.strictEqual(churchLog.actorId, null, 'operators are not church users');
  const opLog = await db.platformAuditLog.findFirst({ where: { churchId: target.churchId, event: 'platform.plan_upgraded' } });
  assert.strictEqual(opLog.operatorEmail, op.email);
});

test('the operator can suspend and reactivate a church; suspension blocks that church', async () => {
  const target = await newChurch('platform-suspend');
  const url = `/api/platform/churches/${target.churchId}/access`;
  assert.strictEqual((await op.client.post(url, { action: 'suspend' })).status, 400);
  assert.strictEqual((await op.client.post(url, { action: 'suspend', reason: 'Unpaid invoice' })).status, 200);
  assert.strictEqual((await target.client.get('/api/settings')).status, 403);
  assert.strictEqual((await op.client.post(url, { action: 'reactivate' })).status, 200);
  assert.strictEqual((await target.client.get('/api/settings')).status, 200);
});

test('delete needs the exact slug; restore brings the church back', async () => {
  const target = await newChurch('platform-delete');
  const { slug } = await db.church.findUnique({ where: { id: target.churchId } });
  const url = `/api/platform/churches/${target.churchId}/access`;
  assert.strictEqual((await op.client.post(url, { action: 'delete', reason: 'Duplicate', confirmSlug: 'wrong' })).status, 400);
  assert.strictEqual((await op.client.post(url, { action: 'delete', reason: 'Duplicate', confirmSlug: slug })).status, 200);
  assert.strictEqual((await target.client.get('/api/settings')).status, 403);
  assert.strictEqual((await op.client.post(url, { action: 'restore' })).status, 200);
  assert.strictEqual((await target.client.get('/api/settings')).status, 200);
});

test('signed in to a deleted church, Sign out works and the operator console is still reachable', async () => {
  const target = await newChurch('platform-stuck');
  const { slug } = await db.church.findUnique({ where: { id: target.churchId } });
  assert.strictEqual((await op.client.post(`/api/platform/churches/${target.churchId}/access`, { action: 'delete', reason: 'test', confirmSlug: slug })).status, 200);

  const gate = await target.client.page('/login');
  assert.strictEqual(gate.status, 302, 'still signed in, so /login sends them on');
  const home = await target.client.page('/');
  assert.strictEqual(home.status, 403);
  assert.match(home.text, /This church has been deleted: test/);
  assert.match(home.text, /<form method="post" action="\/logout"><input type="hidden" name="_csrf"/, 'the Sign out form carries its token');

  // The operator sign-in is not hidden behind the church's screen.
  assert.strictEqual((await target.client.page('/platform')).location, '/platform/login');
  assert.strictEqual((await target.client.page('/platform/login')).status, 200);

  const out = await target.client.form('/logout', {}, '/');
  assert.strictEqual(out.status, 302);
  assert.strictEqual(out.location, '/login');
  const login = await target.client.page('/login');
  assert.strictEqual(login.status, 200, 'signed out: the sign-in page shows');
});

test('the HTML console: list, church page, and a plan change by form', async () => {
  const target = await newChurch('platform-html');
  const list = await op.client.page('/platform');
  assert.strictEqual(list.status, 200);
  assert.match(list.text, /Platform console/);
  assert.match(list.text, /Churches onboarded/);
  assert.strictEqual((await op.client.page(`/platform/churches/${target.churchId}`)).status, 200);
  const res = await op.client.form(`/platform/churches/${target.churchId}/plan`, { plan: 'pro', months: '6' }, `/platform/churches/${target.churchId}`);
  assert.strictEqual(res.status, 302);
  assert.strictEqual((await db.church.findUnique({ where: { id: target.churchId } })).plan, 'pro');
});

test('deleting a church frees its login emails; restoring takes them back unless another account took one', async () => {
  const ownerEmail = unique('freed-owner');
  const target = await newChurch('platform-free-emails', ownerEmail);
  const url = `/api/platform/churches/${target.churchId}/access`;
  const { slug } = await db.church.findUnique({ where: { id: target.churchId } });

  const deleted = await op.client.post(url, { action: 'delete', reason: 'Signed up by mistake', confirmSlug: slug });
  assert.strictEqual(deleted.status, 200);
  assert.strictEqual(deleted.body.releasedEmails, 1);
  assert.strictEqual(await db.user.count({ where: { email: ownerEmail } }), 0, 'the email is free');

  // the freed email can be used again, e.g. to sign up a new church
  const again = await newChurch('platform-free-emails-again', ownerEmail);
  assert.ok(again.churchId);

  const restored = await op.client.post(url, { action: 'restore' });
  assert.strictEqual(restored.status, 200);
  assert.deepStrictEqual(restored.body.emailsTakenMeanwhile, [ownerEmail], 'the clash is reported, not overwritten');

  // once the other account lets go, a later restore puts it back
  const { slug: slug2 } = await db.church.findUnique({ where: { id: again.churchId } });
  await op.client.post(`/api/platform/churches/${again.churchId}/access`, { action: 'delete', reason: 'Duplicate', confirmSlug: slug2 });
  await op.client.post(url, { action: 'delete', reason: 'Again', confirmSlug: slug });
  const second = await op.client.post(url, { action: 'restore' });
  assert.strictEqual(second.body.restoredEmails, 1);
  assert.strictEqual((await db.user.findFirst({ where: { churchId: target.churchId } })).email, ownerEmail);
});
