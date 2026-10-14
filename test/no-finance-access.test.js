'use strict';
// Editors and Viewers without a finance role see a narrower app: Members,
// Attendance, Bible Classes and Organizations as their role allows; Events,
// Preaching Plan and Inventory read-only (Editors can still check people in);
// no Finance, Communications or Reports. Admins and anyone with a finance
// role are unaffected (lib/access.js).
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { createTenantApp } = require('../lib/tenant-http');
const { db } = require('../lib/tenant');
const { signupChurch } = require('../lib/provision');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
let server, base, churchId, owner, limitedEditor, limitedViewer, financeEditor;

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
  return { get: (p) => send('GET', p), post: (p, b) => send('POST', p, b), put: (p, b) => send('PUT', p, b) };
}

async function signIn(email) {
  const c = client();
  assert.strictEqual((await c.post('/login', { email, password: 'password123' })).status, 200);
  return c;
}

async function staff(role, financeRole = 'NONE') {
  const email = unique(`${role}-${financeRole}`.toLowerCase());
  await db.user.create({ data: { churchId, username: `${role}-${financeRole}-${Date.now()}`, email, passwordHash: await bcrypt.hash('password123', 4), role, financeRole } });
  return signIn(email);
}

test.before(async () => {
  const app = createTenantApp({ pool });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  const ownerEmail = unique('owner');
  const { church } = await signupChurch({ churchName: 'Limited Access Church', name: 'Owner', email: ownerEmail, password: 'password123' });
  churchId = church.id;
  await db.church.update({ where: { id: churchId }, data: { plan: 'pro' } });
  owner = await signIn(ownerEmail);
  limitedEditor = await staff('EDITOR');
  limitedViewer = await staff('VIEWER');
  financeEditor = await staff('EDITOR', 'TREASURER');
});

test.after(async () => {
  server.close();
  const where = { churchId };
  await db.activityLog.deleteMany({ where });
  await db.attendance.deleteMany({ where });
  await db.eventRsvp.deleteMany({ where });
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

test('an editor without finance access still adds and edits members', async () => {
  const m = await limitedEditor.post('/api/members', { firstName: 'Ama', lastName: 'Limited' });
  assert.strictEqual(m.status, 201);
  assert.strictEqual((await limitedEditor.put(`/api/members/${m.body.id}`, { firstName: 'Ama', lastName: 'Edited' })).status, 200);
  assert.strictEqual((await limitedEditor.get('/members/new')).status, 200);
  for (const p of ['/attendance', '/bible-classes', '/organizations']) assert.strictEqual((await limitedEditor.get(p)).status, 200, p);
});

test('events are read-only for them, but they can check people in and record RSVPs', async () => {
  const ev = await owner.post('/api/events', { title: 'Harvest', startsAt: new Date().toISOString() });
  assert.strictEqual(ev.status, 201);
  const m = await owner.post('/api/members', { firstName: 'Kofi', lastName: 'Guest' });

  assert.strictEqual((await limitedEditor.post('/api/events', { title: 'x', startsAt: new Date().toISOString() })).status, 403);
  assert.strictEqual((await limitedEditor.put(`/api/events/${ev.body.id}`, { title: 'Renamed', startsAt: new Date().toISOString() })).status, 403);
  assert.strictEqual((await limitedEditor.get('/events/new')).status, 403);
  assert.strictEqual((await limitedEditor.get(`/events/${ev.body.id}/edit`)).status, 403);
  assert.strictEqual((await limitedEditor.post(`/api/events/${ev.body.id}/check`, { memberId: m.body.id })).status, 201);

  const list = await limitedEditor.get('/events');
  assert.strictEqual(list.status, 200);
  assert.doesNotMatch(list.text, /href="\/events\/new"/);
  const detail = await limitedEditor.get(`/events/${ev.body.id}`);
  assert.strictEqual(detail.status, 200);
  assert.doesNotMatch(detail.text, /href="\/events\/\d+\/edit"/);
  assert.match(detail.text, /\/events\/\d+\/check/, 'the check-in panel is still there');
});

test('preaching plan and inventory are read-only for them', async () => {
  for (const c of [limitedEditor, limitedViewer]) {
    assert.strictEqual((await c.get('/preaching')).status, 200);
    assert.strictEqual((await c.get('/inventory')).status, 200);
    assert.strictEqual((await c.post('/api/preaching', { date: '2026-11-01', preacher: 'Rev', theme: 't' })).status, 403);
    assert.strictEqual((await c.post('/api/inventory', { name: 'Chairs', quantity: 10 })).status, 403);
  }
});

test('finance, communications and reports are closed to them and gone from the menu', async () => {
  for (const c of [limitedEditor, limitedViewer]) {
    for (const p of ['/finance', '/communications', '/reports', '/api/communications/broadcasts', '/api/reports/members/missing']) {
      assert.strictEqual((await c.get(p)).status, 403, p);
    }
    const home = await c.get('/');
    assert.strictEqual(home.status, 200, 'the dashboard stays');
    for (const href of ['/finance', '/communications', '/reports']) assert.doesNotMatch(home.text, new RegExp(`href="${href}"`), href);
    assert.match(home.text, /href="\/members"/);
    assert.match(home.text, /href="\/events"/);
  }
  assert.doesNotMatch((await limitedEditor.get('/')).text, /Schedule event/);
});

test('an editor with a finance role and an admin are unaffected', async () => {
  for (const c of [financeEditor, owner]) {
    assert.strictEqual((await c.post('/api/events', { title: 'Choir', startsAt: new Date().toISOString() })).status, 201);
    assert.strictEqual((await c.get('/communications')).status, 200);
    assert.strictEqual((await c.get('/reports')).status, 200);
    const home = await c.get('/');
    assert.match(home.text, /href="\/communications"/);
    assert.match(home.text, /href="\/reports"/);
    assert.match(home.text, /Schedule event/);
  }
});
