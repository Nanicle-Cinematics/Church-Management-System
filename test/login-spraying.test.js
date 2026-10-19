'use strict';
// One IP trying many different addresses must be throttled, even though each
// address on its own stays far below the per-email limit.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { createTenantApp } = require('../lib/tenant-http');
const { db } = require('../lib/tenant');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
let server, base;

test.before(async () => {
  const app = createTenantApp({ pool });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { server.close(); await db.$disconnect(); await pool.end(); });

test('password spraying: the 101st login attempt from one IP is refused, whatever the email', async () => {
  const attempt = (i) => fetch(base + '/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `spray-${process.pid}-${i}@example.test`, password: 'Password1!' }) });
  const statuses = [];
  for (let i = 0; i < 101; i++) statuses.push((await attempt(i)).status);
  assert.ok(statuses.slice(0, 100).every((s) => s === 401), 'the first 100 are ordinary wrong-password answers');
  assert.strictEqual(statuses[100], 429);
});
