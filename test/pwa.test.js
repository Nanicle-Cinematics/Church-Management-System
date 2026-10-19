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
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { LOGO_DIR, deleteTenantLogo } = require('../lib/church-logo');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
let server, base, churchId, cookie;

test.before(async () => {
  const app = createTenantApp({ pool });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  const email = `pwa-${process.pid}-${Date.now()}@example.test`;
  const { church } = await signupChurch({ churchName: 'Pwa Test Church', name: 'Owner', email, password: 'Tr0ubadour-7!' });
  churchId = church.id;
  const res = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'Tr0ubadour-7!' }) });
  assert.strictEqual(res.status, 200);
  cookie = res.headers.getSetCookie().find((c) => c.startsWith('connect.sid=')).split(';')[0];
});

test.after(async () => {
  server.close();
  deleteTenantLogo(churchId);
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

test('signed out, the manifest is the product\'s and makes the app installable everywhere', async () => {
  const res = await get('/manifest.webmanifest');
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/manifest\+json/);
  const m = await res.json();
  assert.strictEqual(m.name, 'Church Manager');
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
    assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest" crossorigin="use-credentials">/, p);
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

test('signed in, the installed app carries the church\'s name, then its logo once uploaded', async () => {
  const manifest = async (headers = { cookie }) => (await get('/manifest.webmanifest', headers)).json();
  const head = async () => (await (await get('/', { cookie })).text()).split('</head>')[0];

  // No logo yet: the church's name with the product icons.
  let m = await manifest();
  assert.strictEqual(m.name, 'Pwa Test Church');
  assert.strictEqual(m.short_name, 'Pwa Test Church');
  assert.ok(m.icons.every((i) => i.src.startsWith('/static/')));
  let tags = await head();
  assert.match(tags, /<meta name="apple-mobile-web-app-title" content="Pwa Test Church">/);
  assert.match(tags, /<link rel="apple-touch-icon" href="\/static\/apple-touch-icon\.png">/);
  const res = await get('/manifest.webmanifest', { cookie });
  assert.match(res.headers.get('cache-control'), /private/);

  // A wide logo becomes square icons, with or without a session.
  await sharp({ create: { width: 600, height: 200, channels: 4, background: '#c81e1e' } }).png().toFile(path.join(LOGO_DIR, `${churchId}.png`));
  m = await manifest();
  for (const size of [192, 512]) {
    for (const purpose of ['any', 'maskable']) {
      const icon = m.icons.find((i) => i.sizes === `${size}x${size}` && i.purpose === purpose);
      assert.ok(icon && icon.src.startsWith(`/branding/app-icon/${churchId}/`), `${size} ${purpose}`);
      const img = await get(icon.src);
      assert.strictEqual(img.status, 200);
      assert.strictEqual(img.headers.get('content-type'), 'image/png');
      const meta = await sharp(Buffer.from(await img.arrayBuffer())).metadata();
      assert.deepStrictEqual([meta.width, meta.height], [size, size]);
    }
  }
  assert.ok(m.shortcuts.every((s) => s.icons[0].src === m.icons[0].src));
  tags = await head();
  const apple = tags.match(/<link rel="apple-touch-icon" href="([^"]+)">/)[1];
  assert.match(apple, new RegExp(`^/branding/app-icon/${churchId}/[^/]+/[^/]+/180\\.png$`));
  assert.strictEqual((await get(apple)).status, 200);

  // A link cannot be forged to reach another church's logo.
  const parts = m.icons[0].src.split('/');
  parts[5] = 'A'.repeat(parts[5].length);
  assert.strictEqual((await get(parts.join('/'))).status, 404);
  assert.strictEqual((await get(m.icons[0].src.replace('/192.png', '/999.png'))).status, 404);

  // Signed out still gets the product's manifest.
  assert.strictEqual((await manifest({})).name, 'Church Manager');

  // Removing the logo: old links show the product icon again.
  const old = m.icons[1].src;
  deleteTenantLogo(churchId);
  const after = await get(old);
  assert.strictEqual(after.status, 200);
  const product = fs.readFileSync(path.join(__dirname, '..', 'public', 'icon-192.png'));
  assert.ok(Buffer.from(await after.arrayBuffer()).equals(product));
});

test('long church names are shortened for the home screen', () => {
  const { shortName } = require('../lib/app-icon');
  assert.strictEqual(shortName('Grace Chapel'), 'Grace Chapel');
  assert.strictEqual(shortName('Dunwell Methodist Society, Koforidua'), 'Dunwell');
  assert.strictEqual(shortName('Presbyterian Church of Ghana Emmanuel Congregation'), 'Presbyterian');
  assert.strictEqual(shortName('Supercalifragilisticexpialidocious'), 'Supercalifragil');
});
