'use strict';
// The session store must never wake Postgres on its own. connect-pg-simple's
// default prune timer (a DELETE every 15 minutes) kept Neon's compute awake a
// third of every month with zero users — the same failure as the /readyz poll.
// Pruning now happens only when lib/operations-scheduler.js asks for it.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { createTenantApp, pruneExpiredSessions } = require('../lib/tenant-http');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
test.after(() => pool.end());

test('the session store schedules no prune timer, even after a session is touched', async () => {
  // Same options createTenantApp passes (mirrored so a regression there is
  // caught by the end-to-end check below, and here by the direct one).
  const store = new pgSession({ pool, tableName: 'session', createTableIfMissing: false, pruneSessionInterval: false });
  await new Promise((resolve, reject) => store.get('no-such-sid', (err) => (err ? reject(err) : resolve())));
  assert.strictEqual(store.pruneTimer, undefined, 'a get() must not start the prune timer');

  const control = new pgSession({ pool, tableName: 'session', createTableIfMissing: false });
  await new Promise((resolve, reject) => control.get('no-such-sid', (err) => (err ? reject(err) : resolve())));
  assert.ok(control.pruneTimer, 'sanity: the library default DOES start a timer, so the assertion above is load-bearing');
  await control.close();
});

test('the real app touches the store without starting a prune timer', async () => {
  const app = createTenantApp({ pool });
  // express-session only exposes the store per request, so read it off one.
  let store;
  app.get('/__store-probe', (req, res) => { store = req.sessionStore; res.end(); });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    await (await fetch(`${base}/login`)).text(); // issues a session (CSRF token) — touches the store
    await (await fetch(`${base}/__store-probe`)).text();
    assert.ok(store, 'probe did not see a session store');
    assert.strictEqual(store.pruneTimer, undefined);
  } finally {
    server.close();
  }
});

test('pruneExpiredSessions removes only expired rows', async () => {
  const live = `prune-test-live-${Date.now()}`;
  const dead = `prune-test-dead-${Date.now()}`;
  await pool.query(
    'INSERT INTO "session" (sid, sess, expire) VALUES ($1, $2, NOW() + interval \'1 hour\'), ($3, $2, NOW() - interval \'1 hour\')',
    [live, JSON.stringify({ cookie: {} }), dead],
  );
  try {
    const removed = await pruneExpiredSessions();
    assert.ok(removed >= 1, `expected at least the expired row to go, got ${removed}`);
    const { rows } = await pool.query('SELECT sid FROM "session" WHERE sid = ANY($1)', [[live, dead]]);
    assert.deepStrictEqual(rows.map((r) => r.sid), [live]);
  } finally {
    await pool.query('DELETE FROM "session" WHERE sid = ANY($1)', [[live, dead]]);
  }
});

test('pruneExpiredSessions refuses an unsafe table name', async () => {
  await assert.rejects(() => pruneExpiredSessions('session"; DROP TABLE x; --'), /bad session table name/);
});
