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
const vm = require('vm');
const { welcomePage, STYLES, safeNext } = require('../lib/welcome');
const W = require('../lib/welcome-colours');

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
  assert.match((await c.page('/settings')).text, /name="welcomeStyle" value="pop" checked/, 'Pop and rings by default');
  await c.form('/settings/welcome', { welcomeStyle: 'off', colourMode: 'logo' }, '/settings');
  assert.strictEqual((await db.church.findUnique({ where: { id: church.id } })).welcomeAnimation, false);
  const c2 = client();
  assert.strictEqual((await c2.form('/login', { email, password: PASSWORD }, '/login')).location, '/welcome');
  assert.strictEqual((await c2.page('/welcome')).location, '/', 'off: no animation');
  assert.strictEqual((await c2.page('/')).status, 200);
  assert.match((await c.page('/settings')).text, /name="welcomeStyle" value="off" checked/);

  // back on, in another style and a colour the church chose
  await c.form('/settings/welcome', { welcomeStyle: 'sunburst', colourMode: 'custom', welcomeColour: '#1E7F4A' }, '/settings');
  const saved = await db.church.findUnique({ where: { id: church.id } });
  assert.deepStrictEqual([saved.welcomeAnimation, saved.welcomeStyle, saved.welcomeColour], [true, 'sunburst', '#1e7f4a']);
  const c3 = client();
  await c3.form('/login', { email, password: PASSWORD }, '/login');
  const shown = await c3.page('/welcome');
  assert.strictEqual(shown.status, 200);
  assert.match(shown.text, /class="welcome welcome-sunburst"/);
  assert.match(shown.text, /class="welcome-rays"/);
  assert.match(shown.text, /--w1:#[0-9a-f]{6};--w2:#[0-9a-f]{6};--w3:#[0-9a-f]{6}/, 'the church colour reaches the page');

  // bad input is ignored: an unknown style falls back, a bad colour means "use my logo"
  await c.form('/settings/welcome', { welcomeStyle: 'confetti', colourMode: 'custom', welcomeColour: 'red; background:url(x)' }, '/settings');
  const fallback = await db.church.findUnique({ where: { id: church.id } });
  assert.deepStrictEqual([fallback.welcomeStyle, fallback.welcomeColour], ['pop', null]);

  // an admin can preview any style from Settings; it returns to Settings and does not need a fresh sign-in
  const prev = await c.page('/welcome?preview=1&style=rise');
  assert.strictEqual(prev.status, 200);
  assert.match(prev.text, /welcome-rise/);
  assert.match(prev.text, /data-next="\/settings"/);
  assert.strictEqual((await c.page('/welcome')).location, '/', 'but a plain visit still goes to the dashboard');

  // opened afresh: the page carries the launch script while the animation is on, and /welcome?launch=1 shows it
  await c.form('/settings/welcome', { welcomeStyle: 'rise', colourMode: 'logo' }, '/settings');
  const dash = (await c.page('/')).text;
  assert.match(dash, /<script src="\/static\/app-launch\.js\?v=[^"]+"><\/script>/, 'the launch script is in the head of the app pages');
  assert.ok(dash.indexOf('app-launch.js') < dash.indexOf('styles.css'), 'before anything paints');
  const launched = await c.page('/welcome?launch=1&next=%2Fmembers%3Fq%3Dama');
  assert.strictEqual(launched.status, 200);
  assert.match(launched.text, /welcome-rise/);
  assert.match(launched.text, /data-next="\/members\?q=ama"/, 'it goes on to the page that was asked for');
  assert.match((await c.page('/welcome?launch=1&next=https%3A%2F%2Fevil.example%2F')).text, /data-next="\/"/, 'never to another site');
  assert.match((await c.page('/welcome?launch=1&next=%2F%2Fevil.example')).text, /data-next="\/"/);
  assert.match((await c.page('/welcome?launch=1')).text, /data-next="\/"/);
  assert.strictEqual((await client().page('/welcome?launch=1')).location, '/login', 'signed out: to sign in');
  // turned off: no script on the pages, and a launch visit goes straight on
  await c.form('/settings/welcome', { welcomeStyle: 'off', colourMode: 'logo' }, '/settings');
  assert.doesNotMatch((await c.page('/')).text, /app-launch\.js/);
  assert.strictEqual((await c.page('/welcome?launch=1&next=%2Fmembers')).location, '/members');
  await c.form('/settings/welcome', { welcomeStyle: 'pop', colourMode: 'logo' }, '/settings');

  // only the admin can change it
  await db.user.create({ data: { churchId: church.id, username: `ed-${Date.now()}`, email: `ed-${process.pid}-${Date.now()}@example.test`, passwordHash: require('bcryptjs').hashSync(PASSWORD, 4), role: 'EDITOR', financeRole: 'NONE', emailVerifiedAt: new Date() } });
  const editorEmail = (await db.user.findFirst({ where: { churchId: church.id, role: 'EDITOR' } })).email;
  const ed = client();
  await ed.form('/login', { email: editorEmail, password: PASSWORD }, '/login');
  assert.strictEqual((await ed.form('/settings/welcome', { welcomeStyle: 'off' }, '/profile')).status, 403);
  assert.strictEqual((await db.church.findUnique({ where: { id: church.id } })).welcomeAnimation, true);
  await ed.page('/welcome'); // their own welcome screen, used up
  assert.strictEqual((await ed.page('/welcome?preview=1&style=rise')).location, '/', 'only an admin can preview');

  // the logo it shows is served
  const logo = await fetch(`${base}/branding/logo`, { headers: { cookie: '' } });
  assert.strictEqual(logo.status, 200);
});

test('the four styles each get their own markup, and a church colour becomes three readable stops', () => {
  assert.deepStrictEqual(Object.keys(STYLES), ['pop', 'rise', 'reveal', 'sunburst']);
  for (const key of Object.keys(STYLES)) assert.match(welcomePage({ churchName: 'X', style: key }), new RegExp(`class="welcome welcome-${key}"`));
  assert.match(welcomePage({ churchName: 'X', style: 'pop' }), /welcome-rings/);
  assert.match(welcomePage({ churchName: 'X', style: 'sunburst' }), /welcome-rays/);
  assert.doesNotMatch(welcomePage({ churchName: 'X', style: 'rise' }), /welcome-rings|welcome-rays/);
  assert.match(welcomePage({ churchName: 'X', style: 'nonsense' }), /welcome-pop/, 'unknown style: the default');
  assert.doesNotMatch(welcomePage({ churchName: 'X' }), /--w1/, 'no colour: the app\'s own accent');

  for (const hex of ['#1e7f4a', '#b42318', '#f5c518', '#6a3fa0', '#ffffff', '#000000', '#7fffd4']) {
    const p = W.palette(hex);
    assert.ok(W.whiteContrast(W.hexToRgb(p.deep)) >= 4.5 && W.whiteContrast(W.hexToRgb(p.mid)) >= 4.5, `${hex}: white text reads on the background`);
  }
  assert.strictEqual(W.palette('red'), null);
  assert.strictEqual(W.palette('#12345'), null);
  assert.deepStrictEqual(W.palette('#808080').deep.slice(1).match(/../g).filter((v, i, a) => v === a[0]).length, 3, 'a grey stays grey');
});

test('the colour is taken from the logo\'s most vivid colour, ignoring paper, ink and transparency', async () => {
  const sharp = require('sharp');
  const png = await sharp({ create: { width: 40, height: 40, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } })
    .composite([{ input: await sharp({ create: { width: 24, height: 24, channels: 3, background: { r: 200, g: 30, b: 40 } } }).png().toBuffer(), left: 8, top: 8 }, { input: await sharp({ create: { width: 6, height: 6, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer(), left: 0, top: 0 }])
    .png().toBuffer();
  const file = path.join(require('os').tmpdir(), `logo-${process.pid}.png`);
  fs.writeFileSync(file, png);
  try {
    const c = W.hexToRgb(await W.dominantColour(file));
    assert.ok(c[0] > 150 && c[1] < 80 && c[2] < 90, 'the red square, not the white page or the black corner');
  } finally { fs.unlinkSync(file); }
  const blank = path.join(require('os').tmpdir(), `grey-${process.pid}.png`);
  fs.writeFileSync(blank, await sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 120, g: 120, b: 120 } } }).png().toBuffer());
  try { assert.strictEqual(await W.dominantColour(blank), null, 'a logo with no colour in it: null, so the app colour is used'); } finally { fs.unlinkSync(blank); }
});

test('safeNext keeps to pages of this app', () => {
  for (const ok of ['/', '/members', '/members?q=ama', '/finance/income#top']) assert.strictEqual(safeNext(ok), ok, ok);
  for (const bad of ['//evil.example', '/\\evil', 'https://evil.example', 'javascript:alert(1)', '/welcome', '/welcome?x=1', '/a b', '/<x>', '', null, undefined, 5]) assert.strictEqual(safeNext(bad), '/', String(bad));
});

test('the relaunch script: opened afresh it shows the welcome screen once; moving around, reloads and blocked storage do not', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'public', 'app-launch.js'), 'utf8');
  const run = ({ referrer = '', pathname = '/finance', search = '', hash = '', store = {}, blocked = false } = {}) => {
    const replaced = [];
    const sessionStorage = blocked
      ? { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } }
      : { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
    vm.runInNewContext(code, { window: { sessionStorage }, document: { referrer }, location: { origin: 'https://app.example', pathname, search, hash, replace: (u) => replaced.push(u) }, URL, encodeURIComponent });
    return { replaced, store };
  };
  const fresh = run({ pathname: '/finance/income', search: '?x=1', hash: '#top' });
  assert.deepStrictEqual(fresh.replaced, ['/welcome?launch=1&next=' + encodeURIComponent('/finance/income?x=1#top')], 'a fresh launch goes to the welcome screen, then on to where it was going');
  assert.strictEqual(fresh.store.welcomed, '1');
  assert.deepStrictEqual(run({ store: fresh.store }).replaced, [], 'the same window does not show it again (reloads, later pages)');
  const inside = run({ referrer: 'https://app.example/members' });
  assert.deepStrictEqual(inside.replaced, [], 'a link opened from inside the app (a new tab) is not a relaunch');
  assert.strictEqual(inside.store.welcomed, '1');
  assert.strictEqual(run({ referrer: 'https://other.example/page' }).replaced.length, 1, 'arriving from another site is a launch');
  assert.deepStrictEqual(run({ pathname: '/welcome' }).replaced, [], 'never on the welcome page itself');
  assert.deepStrictEqual(run({ blocked: true }).replaced, [], 'storage blocked: nothing happens, nothing breaks');
});

test('the logo is shown on its own on plain white: no card around it, dark text, and the church colour only as the accent', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  const block = css.slice(css.indexOf('/* Welcome screen (lib/welcome.js)'));
  const logoRule = block.match(/\.welcome-logo \{[^}]*\}/)[0];
  assert.ok(!/background|border-radius|box-shadow|padding/.test(logoRule), 'no white card, rounding, shadow or padding around the logo');
  assert.match(block, /\.welcome-body \{[^}]*background: #fff/);
  assert.match(block, /\.welcome \{[^}]*background: #fff/, 'a plain white screen, so any logo blends in');
  assert.match(block, /\.welcome-name \{[^}]*color: #1d1d24/, 'dark name on white');
  assert.ok(!/linear-gradient|radial-gradient/.test(block.slice(0, block.indexOf('/* Pop and rings */'))), 'no gradient behind the logo');
  assert.match(block, /color-mix\(in srgb, var\(--accent\)/, 'the church colour shows in the rings and rays');
});
