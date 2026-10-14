'use strict';
// Installable app (public/manifest.webmanifest, public/sw.js, public/pwa.js):
// every page someone might install from carries the manifest and the install
// script, the manifest meets what Chrome, Edge, Android and iOS need, and the
// service worker shows an offline page without caching church pages.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { createTenantApp } = require('../lib/tenant-http');
const { db } = require('../lib/tenant');
const { signupChurch } = require('../lib/provision');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
let server, base, churchId, cookie;

test.before(async () => {
  const app = createTenantApp({ pool });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  const email = `pwa-${process.pid}-${Date.now()}@example.test`;
  const { church } = await signupChurch({ churchName: 'Pwa Test Church', name: 'Owner', email, password: 'password123' });
  churchId = church.id;
  const res = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'password123' }) });
  assert.strictEqual(res.status, 200);
  cookie = res.headers.getSetCookie().find((c) => c.startsWith('connect.sid=')).split(';')[0];
});

test.after(async () => {
  server.close();
  const where = { churchId };
  await db.account.deleteMany({ where });
  await db.user.deleteMany({ where });
  await db.specialCategory.deleteMany({ where });
  await db.serviceType.deleteMany({ where });
  await db.expenseCategory.deleteMany({ where });
  await db.church.deleteMany({ where: { id: churchId } });
  await db.$disconnect();
  await pool.end();
});

const get = (p, headers = {}) => fetch(base + p, { headers, redirect: 'manual' });

test('the manifest makes the app installable everywhere', async () => {
  const res = await get('/manifest.webmanifest');
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/manifest\+json/);
  const m = await res.json();
  assert.strictEqual(m.id, '/');
  assert.strictEqual(m.start_url, '/');
  assert.strictEqual(m.display, 'standalone');
  assert.ok(m.name && m.short_name && m.description);
  for (const size of ['192x192', '512x512']) {
    assert.ok(m.icons.some((i) => i.sizes === size && i.purpose === 'any'), `${size} icon`);
    assert.ok(m.icons.some((i) => i.sizes === size && i.purpose === 'maskable'), `${size} maskable icon`);
  }
  for (const i of m.icons) assert.strictEqual((await get(i.src)).status, 200, i.src);
  for (const s of m.shortcuts) assert.ok(s.url.startsWith('/') && !s.url.startsWith('//'), s.url);
});

test('the service worker keeps notifications, shows an offline page, and caches no church pages', async () => {
  const sw = await get('/sw.js');
  assert.strictEqual(sw.status, 200);
  assert.strictEqual(sw.headers.get('service-worker-allowed'), '/');
  const text = await sw.text();
  assert.match(text, /showNotification/);
  assert.match(text, /notificationclick/);
  assert.match(text, /\/static\/offline\.html/);
  assert.doesNotMatch(text, /cache\.put\(/, 'pages are never written to the cache');
  const offline = await get('/static/offline.html');
  assert.strictEqual(offline.status, 200);
  assert.match(await offline.text(), /You're offline/);
  assert.strictEqual((await get('/static/pwa.js')).status, 200);
});

test('install tags and the install script are on the signed-out, landing and signed-in pages', async () => {
  const pages = [
    ['/login', {}],
    ['/signup', {}],
    ['/forgot', {}],
    ['/', {}],
    ['/', { cookie }],
    ['/members', { cookie }],
  ];
  for (const [p, headers] of pages) {
    const res = await get(p, headers);
    assert.strictEqual(res.status, 200, `${p} ${headers.cookie ? 'signed in' : 'signed out'}`);
    const html = await res.text();
    assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest">/, p);
    assert.match(html, /<link rel="apple-touch-icon"/, p);
    assert.match(html, /<meta name="theme-color"/, p);
    assert.match(html, /<script src="\/static\/pwa\.js\?v=[0-9a-f]+" defer><\/script>/, p);
  }
});

test('"Install app" starts hidden and is offered in the sidebar, the phone menu and on sign-in', async () => {
  const app = await (await get('/', { cookie })).text();
  assert.match(app, /<button class="pc-item pc-install" type="button" data-install-app hidden>/);
  assert.match(app, /<button class="pc-tile" type="button" data-sheet-cmd="install" data-install-app hidden/);
  assert.match(app, /cmd === 'install' && window\.PwaInstall/);
  const login = await (await get('/login')).text();
  assert.match(login, /<button class="pa-install" type="button" data-install-app hidden>/);
});
