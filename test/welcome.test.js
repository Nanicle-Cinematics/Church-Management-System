'use strict';
// The welcome screen after sign-in: shown once, right after signing in, carrying the church's
// own name and logo, and never in the way of the dashboard.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { createTenantApp } = require('../lib/tenant-http');
const { db } = require('../lib/tenant');
const { signupChurch } = require('../lib/provision');
const { welcomePage } = require('../lib/welcome');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const PASSWORD = 'Tr0ubadour-7!';
const churchIds = [];
let server, base;

function client() {
  let cookie;
  const remember = (res) => { for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) if (c.startsWith('connect.sid=')) cookie = c.split(';')[0]; };
  const api = {
    async page(p) { const res = await fetch(base + p, { headers: cookie ? { cookie } : {}, redirect: 'manual' }); remember(res); return { status: res.status, location: res.headers.get('location'), text: await res.text() }; },
    async form(p, fields, from = p) {
      const csrf = ((await api.page(from)).text.match(/name="_csrf" value="([^"]*)"/) || [])[1] || '';
      const res = await fetch(base + p, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) }, body: new URLSearchParams({ ...fields, _csrf: csrf }).toString() });
      remember(res); return { status: res.status, location: res.headers.get('location'), text: await res.text() };
    },
  };
  return api;
}

test.before(async () => {
  const app = createTenantApp({ pool });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  server.close();
  const where = { churchId: { in: churchIds } };
  for (const m of ['activityLog', 'securityAuditLog', 'account', 'user', 'specialCategory', 'serviceType', 'expenseCategory']) await db[m].deleteMany({ where }).catch(() => {});
  await db.church.deleteMany({ where: { id: { in: churchIds } } }).catch(() => {});
  await db.$disconnect();
  await pool.end();
});

test('the page carries the church\'s logo and name, escapes them, runs no inline script, and moves on by itself', () => {
  const html = welcomePage({ churchName: 'St. <b>Mark</b> Methodist', firstName: 'Ama', liturgical: 'GREEN' });
  assert.match(html, /<img src="\/branding\/logo"/);
  assert.match(html, /St\. &lt;b&gt;Mark&lt;\/b&gt; Methodist/);
  assert.ok(!html.includes('<b>Mark'));
  assert.match(html, /Welcome, Ama/);
  assert.match(html, /data-liturgical="green"/);
  assert.match(html, /<meta http-equiv="refresh" content="\d+;url=\/">/, 'moves on even if scripts cannot run');
  assert.match(html, /data-ms="3200"/);
  assert.ok(!/<script(?![^>]*\ssrc=)[^>]*>/i.test(html) && !/\son[a-z]+=/i.test(html), 'no inline script or handler');
  assert.match(welcomePage({ churchName: 'X' }), />Welcome</, 'no name: just Welcome');
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', 'js', 'welcome.js')));
});

test('right after signing in the welcome screen is shown once; the dashboard is untouched', async () => {
  const email = `welcome-${process.pid}-${Date.now()}@example.test`;
  const { church } = await signupChurch({ churchName: 'Welcome Church', name: 'Ama Owner', email, password: PASSWORD });
  churchIds.push(church.id);

  const c = client();
  assert.strictEqual((await c.page('/welcome')).location, '/login', 'signed out: to sign in');
  const login = await c.form('/login', { email, password: PASSWORD }, '/login');
  assert.strictEqual(login.status, 302);
  assert.strictEqual(login.location, '/welcome', 'sign-in goes to the welcome screen');

  const w = await c.page('/welcome');
  assert.strictEqual(w.status, 200);
  assert.ok(w.text.includes('Welcome Church') && w.text.includes('Welcome, Ama') && w.text.includes('/branding/logo'));
  const again = await c.page('/welcome');
  assert.strictEqual(again.location, '/', 'a second visit goes straight to the dashboard');

  const home = await c.page('/');
  assert.strictEqual(home.status, 200);
  assert.ok(home.text.includes('pd-head') || home.text.includes('Dashboard'), '/ is still the dashboard');
  assert.ok(!home.text.includes('welcome-name'));

  // an admin can turn it off in Settings: sign-in then goes straight to the dashboard, for everyone
  assert.match((await c.page('/settings')).text, /name="welcomeAnimation" value="1" checked/, 'on by default');
  await c.form('/settings/welcome', {}, '/settings');
  assert.strictEqual((await db.church.findUnique({ where: { id: church.id } })).welcomeAnimation, false);
  const c2 = client();
  assert.strictEqual((await c2.form('/login', { email, password: PASSWORD }, '/login')).location, '/welcome');
  assert.strictEqual((await c2.page('/welcome')).location, '/', 'off: no animation');
  assert.strictEqual((await c2.page('/')).status, 200);
  assert.doesNotMatch((await c.page('/settings')).text, /name="welcomeAnimation" value="1" checked/);

  // and back on
  await c.form('/settings/welcome', { welcomeAnimation: '1' }, '/settings');
  const c3 = client();
  await c3.form('/login', { email, password: PASSWORD }, '/login');
  assert.strictEqual((await c3.page('/welcome')).status, 200, 'on again: the animation is back');

  // only the admin can change it
  await db.user.create({ data: { churchId: church.id, username: `ed-${Date.now()}`, email: `ed-${process.pid}-${Date.now()}@example.test`, passwordHash: require('bcryptjs').hashSync(PASSWORD, 4), role: 'EDITOR', financeRole: 'NONE', emailVerifiedAt: new Date() } });
  const editorEmail = (await db.user.findFirst({ where: { churchId: church.id, role: 'EDITOR' } })).email;
  const ed = client();
  await ed.form('/login', { email: editorEmail, password: PASSWORD }, '/login');
  assert.strictEqual((await ed.form('/settings/welcome', {}, '/profile')).status, 403);
  assert.strictEqual((await db.church.findUnique({ where: { id: church.id } })).welcomeAnimation, true);

  // the logo it shows is served
  const logo = await fetch(`${base}/branding/logo`, { headers: { cookie: '' } });
  assert.strictEqual(logo.status, 200);
});
