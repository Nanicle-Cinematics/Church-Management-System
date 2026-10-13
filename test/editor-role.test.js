'use strict';
// The Editor role: adds and edits everyday records, but cannot delete or
// archive, export member data, or send messages. Viewers stay read-only.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { createTenantApp } = require('../lib/tenant-http');
const { db } = require('../lib/tenant');
const { signupChurch } = require('../lib/provision');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
let server, base, churchId, editor, viewer;

const unique = (tag) => `${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;

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
    return { status: res.status, body: parsed, text };
  };
  return { get: (p) => send('GET', p), post: (p, b) => send('POST', p, b), put: (p, b) => send('PUT', p, b), del: (p) => send('DELETE', p) };
}

async function signedIn(role) {
  const email = unique(role.toLowerCase());
  await db.user.create({ data: { churchId, username: `${role}-${Date.now()}`, email, passwordHash: await bcrypt.hash('password123', 4), role } });
  const c = client();
  assert.strictEqual((await c.post('/login', { email, password: 'password123' })).status, 200);
  return c;
}

test.before(async () => {
  const app = createTenantApp({ pool });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  const { church } = await signupChurch({ churchName: 'Editor Role Church', name: 'Owner', email: unique('owner'), password: 'password123' });
  churchId = church.id;
  editor = await signedIn('EDITOR');
  viewer = await signedIn('VIEWER');
});

test.after(async () => {
  server.close();
  const where = { churchId };
  await db.activityLog.deleteMany({ where });
  await db.event.deleteMany({ where });
  await db.member.deleteMany({ where });
  await db.account.deleteMany({ where });
  await db.user.deleteMany({ where });
  await db.specialCategory.deleteMany({ where });
  await db.serviceType.deleteMany({ where });
  await db.expenseCategory.deleteMany({ where });
  await db.church.deleteMany({ where: { id: churchId } });
  await db.$disconnect();
  await pool.end();
});

test('an editor adds and edits members and events', async () => {
  const created = await editor.post('/api/members', { firstName: 'Ama', lastName: 'Edit' });
  assert.strictEqual(created.status, 201);
  const updated = await editor.put(`/api/members/${created.body.id}`, { firstName: 'Ama', lastName: 'Edited' });
  assert.strictEqual(updated.status, 200);
  const ev = await editor.post('/api/events', { title: 'Choir practice', startsAt: new Date().toISOString() });
  assert.strictEqual(ev.status, 201);
  assert.strictEqual((await editor.post(`/api/events/${ev.body.id}/check`, { memberId: created.body.id })).status, 201);
});

test('an editor cannot delete, export or send messages', async () => {
  const m = await editor.post('/api/members', { firstName: 'Kofi', lastName: 'Keep' });
  assert.strictEqual((await editor.del(`/api/members/${m.body.id}`)).status, 403);
  assert.strictEqual((await editor.get('/members/export.csv')).status, 403);
  assert.strictEqual((await editor.post('/api/communications/broadcasts', { channel: 'SMS', message: 'hi', allMembers: true })).status, 403);
  assert.strictEqual((await editor.get('/users')).status, 403);
});

test('the pages show an editor the add and edit controls, without archive or export', async () => {
  const m = await editor.post('/api/members', { firstName: 'Esi', lastName: 'Page' });
  assert.strictEqual((await editor.get('/members/new')).status, 200);
  const profile = await editor.get(`/members/${m.body.id}`);
  assert.match(profile.text, /Edit details/);
  assert.doesNotMatch(profile.text, />Archive</);
  const list = await editor.get('/members');
  assert.match(list.text, /href="\/members\/new"/);
  assert.doesNotMatch(list.text, /members\/export\.csv/);
});

test('a viewer is still read-only', async () => {
  assert.strictEqual((await viewer.post('/api/members', { firstName: 'No', lastName: 'Write' })).status, 403);
  assert.strictEqual((await viewer.get('/members/new')).status, 403);
  assert.strictEqual((await viewer.post('/api/events', { title: 'x', startsAt: new Date().toISOString() })).status, 403);
});
