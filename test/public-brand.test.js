'use strict';
// Signed-out pages are seen by every church, so they carry the product name,
// never the CHURCH_NAME setting (which names one church). Pages that belong to
// one church (QR check-in) carry that church's own name.
process.env.CHURCH_NAME = 'Setting Church From Env';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { Pool } = require('pg');
const { createTenantApp } = require('../lib/tenant-http');
const { db, tenantDb } = require('../lib/tenant');
const { signupChurch } = require('../lib/provision');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
let server, base, churchId, token;

test.before(async () => {
  const app = createTenantApp({ pool });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  const email = `brand-${process.pid}-${Date.now()}@example.test`;
  const { church } = await signupChurch({ churchName: 'Grace Chapel Brandtest', name: 'Owner', email, password: 'password123' });
  churchId = church.id;
  token = crypto.randomBytes(16).toString('hex');
  await tenantDb(churchId).event.create({ data: { title: 'Sunday', startsAt: new Date(), checkinToken: token } });
});

test.after(async () => {
  server.close();
  const where = { churchId };
  await db.event.deleteMany({ where });
  await db.account.deleteMany({ where });
  await db.user.deleteMany({ where });
  await db.specialCategory.deleteMany({ where });
  await db.serviceType.deleteMany({ where });
  await db.expenseCategory.deleteMany({ where });
  await db.church.deleteMany({ where: { id: churchId } });
  delete process.env.CHURCH_NAME;
  await db.$disconnect();
  await pool.end();
});

for (const path of ['/login', '/signup', '/forgot']) {
  test(`${path} shows the product name, not the CHURCH_NAME setting`, async () => {
    const html = await (await fetch(base + path)).text();
    assert.match(html, /Church Manager/);
    assert.doesNotMatch(html, /Setting Church From Env/);
  });
}

test('a QR check-in page shows its own church\'s name', async () => {
  const html = await (await fetch(`${base}/checkin/${token}`)).text();
  assert.match(html, /Grace Chapel Brandtest/);
  assert.doesNotMatch(html, /Setting Church From Env/);
});
