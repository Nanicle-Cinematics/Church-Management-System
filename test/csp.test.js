'use strict';
// The Content-Security-Policy allows scripts only from our own files, so the
// pages must not carry any: no inline <script>, no inline onclick-style
// handlers, no javascript: links. This reads the page templates (every path a
// page can render, not just the ones a test happens to visit) and fails if
// one comes back. Behaviour goes in public/js/ and is asked for with data-
// attributes (public/js/ui.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { createTenantApp } = require('../lib/tenant-http');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const list = (dir, ext) => fs.readdirSync(path.join(root, dir)).filter((f) => f.endsWith(ext)).map((f) => `${dir}/${f}`);
const templates = [...list('lib', '.js'), ...list('routes-pg-html', '.js'), ...list('public', '.html')];

test('no page template carries inline script, an inline handler, or a javascript: link', () => {
  const problems = [];
  for (const file of templates) {
    const text = read(file);
    for (const m of text.matchAll(/<script\b[^>]*>/g)) {
      if (/\bsrc=/.test(m[0]) || /type="application\/json"/.test(m[0])) continue;
      problems.push(`${file}: inline ${m[0]}`);
    }
    for (const m of text.matchAll(/\son[a-z]+=["']/g)) problems.push(`${file}: inline handler${m[0]}`);
    if (/javascript:/.test(text)) problems.push(`${file}: javascript: link`);
  }
  assert.deepStrictEqual(problems, []);
});

test('every page script a template asks for exists in public/js', () => {
  const missing = [];
  for (const file of templates) {
    for (const m of read(file).matchAll(/scriptTag\('([a-z-]+)'/g)) {
      if (!fs.existsSync(path.join(root, 'public/js', `${m[1]}.js`))) missing.push(`${file}: ${m[1]}`);
    }
  }
  assert.deepStrictEqual(missing, []);
  assert.ok(fs.existsSync(path.join(root, 'public/js/ui.js')));
});

test('the offline page loads its script from the cache the service worker fills', () => {
  const sw = read('public/sw.js');
  assert.match(read('public/offline.html'), /src="\/static\/js\/ui\.js"/);
  assert.match(sw, /OFFLINE_SCRIPT = '\/static\/js\/ui\.js'/);
  assert.match(sw, /cache\.addAll\(\[OFFLINE_URL, \.\.\.OFFLINE_ASSETS\]\)/);
});

test('the policy sent with every response allows scripts only from this site', async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const app = createTenantApp({ pool, sessionSecret: 'test-secret' });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/healthz`);
    const csp = res.headers.get('content-security-policy');
    const script = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src'));
    assert.strictEqual(script, "script-src 'self'");
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /object-src 'none'/);
  } finally {
    server.close();
    await pool.end();
  }
});
