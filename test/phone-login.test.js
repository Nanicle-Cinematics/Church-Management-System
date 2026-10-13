'use strict';
// Staff added by an admin can sign in with a phone number instead of (or as
// well as) an email. Numbers are stored as +<country><number>, so any common
// way of typing the same number signs in.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { createTenantApp } = require('../lib/tenant-http');
const { db } = require('../lib/tenant');
const { signupChurch } = require('../lib/provision');
const { releaseChurchEmails, reclaimChurchEmails } = require('../lib/church-emails');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const churchIds = [];
let server, base, A, B;

const unique = (tag) => `${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
// A Ghana-style mobile number nobody else in the test database uses.
const freshLocal = () => `02${String(Date.now()).slice(-6)}${Math.floor(Math.random() * 90 + 10)}`;
const stored = (local) => `+233${local.slice(1)}`;

function client() {
  let cookie;
  const send = async (method, p, body) => {
    const res = await fetch(base + p, {
      method, redirect: 'manual',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) if (c.startsWith('connect.sid=')) cookie = c.split(';')[0];
    const text = await res.text();
    let parsed; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: res.status, body: parsed };
  };
  return { get: (p) => send('GET', p), post: (p, b) => send('POST', p, b), put: (p, b) => send('PUT', p, b), del: (p) => send('DELETE', p) };
}

async function adminOf(tag) {
  const email = unique(tag);
  const { church } = await signupChurch({ churchName: `${tag} Church`, name: 'Owner', email, password: 'password123' });
  churchIds.push(church.id);
  // Pro, so the Free plan's staff limit does not get in the way.
  await db.church.update({ where: { id: church.id }, data: { plan: 'pro' } });
  const c = client();
  assert.strictEqual((await c.post('/login', { email, password: 'password123' })).status, 200);
  return { churchId: church.id, client: c };
}

test.before(async () => {
  const app = createTenantApp({ pool });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  A = await adminOf('phone-a');
  B = await adminOf('phone-b');
});

test.after(async () => {
  server.close();
  const where = { churchId: { in: churchIds } };
  await db.securityAuditLog.deleteMany({ where });
  await db.activityLog.deleteMany({ where });
  await db.account.deleteMany({ where });
  await db.user.deleteMany({ where });
  await db.specialCategory.deleteMany({ where });
  await db.serviceType.deleteMany({ where });
  await db.expenseCategory.deleteMany({ where });
  await db.church.deleteMany({ where: { id: { in: churchIds } } });
  await db.$disconnect();
  await pool.end();
});

test('an admin adds a phone-only user, who signs in however the number is typed', async () => {
  const local = freshLocal();
  const created = await A.client.post('/api/users', { username: `steward${Date.now()}`, phone: local, password: 'password123', role: 'VIEWER' });
  assert.strictEqual(created.status, 201);
  assert.strictEqual(created.body.phone, stored(local));
  assert.strictEqual(created.body.email, null);

  const spaced = `${local.slice(0, 3)} ${local.slice(3, 6)} ${local.slice(6)}`;
  for (const typed of [local, spaced, stored(local), `00233${local.slice(1)}`]) {
    const res = await client().post('/login', { email: typed, password: 'password123' });
    assert.strictEqual(res.status, 200, `signs in with ${typed}`);
  }
  assert.strictEqual((await client().post('/login', { email: local, password: 'wrong-password' })).status, 401);
});

test('a user with both can sign in with either; email verification does not block a phone-only user', async () => {
  const local = freshLocal();
  const email = unique('both');
  assert.strictEqual((await A.client.post('/api/users', { username: `both${Date.now()}`, email, phone: local, password: 'password123' })).status, 201);
  assert.strictEqual((await client().post('/login', { email: local, password: 'password123' })).status, 200);

  const phoneOnly = freshLocal();
  await A.client.post('/api/users', { username: `ponly${Date.now()}`, phone: phoneOnly, password: 'password123' });
  process.env.REQUIRE_EMAIL_VERIFICATION = '1';
  try {
    assert.strictEqual((await client().post('/login', { email: phoneOnly, password: 'password123' })).status, 200);
  } finally {
    delete process.env.REQUIRE_EMAIL_VERIFICATION;
  }
});

test('a phone number can only have one account, across churches', async () => {
  const local = freshLocal();
  assert.strictEqual((await A.client.post('/api/users', { username: `one${Date.now()}`, phone: local, password: 'password123' })).status, 201);
  const again = await B.client.post('/api/users', { username: `two${Date.now()}`, phone: `+233${local.slice(1)}`, password: 'password123' });
  assert.strictEqual(again.status, 409);
  assert.match(again.body.error, /another church/);
  assert.strictEqual((await A.client.post('/api/users', { username: 'x', password: 'password123' })).status, 400, 'an email or phone is required');
  assert.strictEqual((await A.client.post('/api/users', { username: 'y', phone: '12', password: 'password123' })).status, 400, 'a bad number is refused');
});

test('removing a user, or deleting their church, frees the number', async () => {
  const local = freshLocal();
  const created = await A.client.post('/api/users', { username: `gone${Date.now()}`, phone: local, password: 'password123' });
  assert.strictEqual((await A.client.del(`/api/users/${created.body.id}`)).status, 204);
  const reuse = await A.client.post('/api/users', { username: `back${Date.now()}`, phone: local, password: 'password123' });
  assert.strictEqual(reuse.status, 201, 'a removed user\'s number can be given to someone new');

  await releaseChurchEmails(db, A.churchId);
  assert.strictEqual(await db.user.count({ where: { phone: stored(local) } }), 0, 'deleting the church frees it');
  const { taken } = await reclaimChurchEmails(db, A.churchId);
  assert.deepStrictEqual(taken, []);
  assert.strictEqual(await db.user.count({ where: { phone: stored(local), churchId: A.churchId } }), 1, 'restoring takes it back');
});

test('a removed user\'s username can be given to someone new, including users removed before this fix', async () => {
  const name = `reuse${Date.now()}`;
  const first = await A.client.post('/api/users', { username: name, email: unique('reuse1'), password: 'password123' });
  assert.strictEqual(first.status, 201);
  assert.strictEqual((await A.client.del(`/api/users/${first.body.id}`)).status, 204);
  assert.strictEqual((await A.client.post('/api/users', { username: name, email: unique('reuse2'), password: 'password123' })).status, 201);

  // An older removal kept the username as it was.
  const legacyName = `legacy${Date.now()}`;
  const legacy = await A.client.post('/api/users', { username: legacyName, email: unique('legacy'), password: 'password123' });
  await db.user.update({ where: { id: legacy.body.id }, data: { deletedAt: new Date(), email: null } });
  assert.strictEqual((await A.client.post('/api/users', { username: legacyName, phone: freshLocal(), password: 'password123' })).status, 201);
  assert.strictEqual((await db.user.findUnique({ where: { id: legacy.body.id } })).username, `deleted+${legacy.body.id}+${legacyName}`);
});

test('an admin edits how a user signs in: add a phone, change the email, keep at least one', async () => {
  const email = unique('edit');
  const created = await A.client.post('/api/users', { username: `edit${Date.now()}`, email, password: 'password123' });
  const id = created.body.id;
  const local = freshLocal();

  const added = await A.client.put(`/api/users/${id}/login`, { email, phone: local });
  assert.strictEqual(added.status, 200);
  assert.strictEqual(added.body.phone, stored(local));
  assert.strictEqual((await client().post('/login', { email: local, password: 'password123' })).status, 200, 'now signs in with the phone');

  const phoneOnly = await A.client.put(`/api/users/${id}/login`, { phone: local });
  assert.strictEqual(phoneOnly.body.email, null);
  assert.strictEqual((await client().post('/login', { email, password: 'password123' })).status, 401, 'the old email no longer signs in');

  assert.strictEqual((await A.client.put(`/api/users/${id}/login`, {})).status, 400, 'at least one is required');
  const otherChurchEmail = (await db.user.findFirst({ where: { churchId: B.churchId } })).email;
  const clash = await A.client.put(`/api/users/${id}/login`, { email: otherChurchEmail, phone: local });
  assert.strictEqual(clash.status, 409);
  assert.strictEqual((await B.client.put(`/api/users/${id}/login`, { phone: local })).status, 404, 'another church cannot edit them');
});
