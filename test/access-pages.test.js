'use strict';
// What people see when they reach something their role does not include, or
// a page that does not exist: the app's own page with the menu and a way
// back, never a bare "Forbidden" or Express's "Cannot GET /x". Also the
// Help page (/help) for every role, and Settings only in admins' menus.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { createTenantApp } = require('../lib/tenant-http');
const { db } = require('../lib/tenant');
const { signupChurch } = require('../lib/provision');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
let server, base, churchId, owner, viewer, editor, treasurer;

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
    return { status: res.status, type: res.headers.get('content-type') || '', text: await res.text() };
  };
  // Browsers ask for pages without a JSON body.
  const page = async (p) => {
    const res = await fetch(base + p, { redirect: 'manual', headers: cookie ? { cookie } : {} });
    return { status: res.status, type: res.headers.get('content-type') || '', text: await res.text() };
  };
  return { page, post: (p, b) => send('POST', p, b) };
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
  const { church } = await signupChurch({ churchName: 'Access Pages Church', name: 'Owner', email: ownerEmail, password: 'password123' });
  churchId = church.id;
  owner = await signIn(ownerEmail);
  viewer = await staff('VIEWER');
  editor = await staff('EDITOR');
  treasurer = await staff('EDITOR', 'TREASURER');
});

test.after(async () => {
  server.close();
  const where = { churchId };
  await db.activityLog.deleteMany({ where });
  await db.account.deleteMany({ where });
  await db.user.deleteMany({ where });
  await db.specialCategory.deleteMany({ where });
  await db.serviceType.deleteMany({ where });
  await db.expenseCategory.deleteMany({ where });
  await db.church.deleteMany({ where: { id: churchId } });
  await db.$disconnect();
  await pool.end();
});

const inApp = (html) => /class="pc-app"/.test(html) && /href="\/"/.test(html);
const sidebar = (html) => (html.match(/<nav class="pc-nav"[\s\S]*?<\/nav>/) || [''])[0];

test('Settings is in admins\' menus only; Help is in everyone\'s', async () => {
  const adminHome = (await owner.page('/')).text;
  assert.match(sidebar(adminHome), /href="\/settings"/);
  for (const c of [viewer, editor, treasurer]) {
    const html = (await c.page('/')).text;
    assert.doesNotMatch(sidebar(html), /href="\/settings"/);
    assert.doesNotMatch(html, /class="pc-tile" href="\/settings"/, 'nor in the phone\'s More menu');
    assert.match(sidebar(html), /href="\/help"/);
  }
});

test('Help opens for every role and only describes what they can open', async () => {
  const sections = (html) => [...html.matchAll(/<section class="card help-card" id="([^"]+)"/g)].map((m) => m[1]);
  const v = await viewer.page('/help');
  assert.strictEqual(v.status, 200);
  assert.ok(inApp(v.text));
  assert.match(v.text, /signed in as <strong>Viewer<\/strong> with <strong>No finance access<\/strong>/);
  assert.ok(!sections(v.text).some((s) => ['help-finance', 'help-communications', 'help-reports', 'help-admin'].includes(s)));
  const t = await treasurer.page('/help');
  assert.ok(sections(t.text).includes('help-finance'));
  assert.ok(!sections(t.text).includes('help-admin'));
  const a = await owner.page('/help');
  assert.ok(['help-finance', 'help-reports', 'help-admin'].every((s) => sections(a.text).includes(s)));
  assert.strictEqual((await client().page('/help')).status, 302, 'signed out goes to sign in');
});

test('a refusal is a page inside the app that says why and how to get access', async () => {
  const settings = await viewer.page('/settings');
  assert.strictEqual(settings.status, 403);
  assert.match(settings.type, /text\/html/);
  assert.ok(inApp(settings.text));
  assert.match(settings.text, /You don’t have access to this/);
  assert.match(settings.text, /Your role \(Viewer\) doesn’t include this/);
  assert.match(settings.text, /ask an administrator/);
  assert.match(settings.text, /Back to dashboard/);

  // A route's own explanation is kept.
  const reports = await viewer.page('/reports');
  assert.strictEqual(reports.status, 403);
  assert.ok(inApp(reports.text));
  assert.match(reports.text, /This area needs finance access/);

  const users = await editor.page('/users');
  assert.strictEqual(users.status, 403);
  assert.ok(inApp(users.text));
});

test('an unknown address is a "Page not found" page, never "Cannot GET"', async () => {
  const signedIn = await viewer.page('/no-such-page');
  assert.strictEqual(signedIn.status, 404);
  assert.ok(inApp(signedIn.text));
  assert.match(signedIn.text, /Page not found/);
  assert.doesNotMatch(signedIn.text, /Cannot GET/);

  const signedOut = await client().page('/no-such-page');
  assert.strictEqual(signedOut.status, 404);
  assert.match(signedOut.text, /Page not found/);
  assert.match(signedOut.text, /href="\/login"/);
  assert.doesNotMatch(signedOut.text, /Cannot GET/);
});

test('the API still answers refusals and unknown paths in JSON', async () => {
  const refused = await fetch(`${base}/api/users`, { headers: { cookie: '' } });
  assert.ok([401, 403].includes(refused.status));
  const missing = await viewer.page('/api/no-such-endpoint');
  assert.strictEqual(missing.status, 404);
  assert.match(missing.type, /application\/json/);
  assert.deepStrictEqual(JSON.parse(missing.text), { error: 'Not found' });
});
