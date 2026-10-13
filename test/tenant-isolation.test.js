'use strict';
// Tenant isolation for links between rows. tenantDb() scopes the row being
// read or written to one church; these tests prove it also refuses a write
// that points at another church's row (a check-in naming another church's
// member, say), and that the event check-in/RSVP forms that used to allow it
// no longer do.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { createTenantApp } = require('../lib/tenant-http');
const { db, tenantDb, TenantRefError } = require('../lib/tenant');
const { signupChurch } = require('../lib/provision');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const createdChurchIds = [];
let server, base, A, B;

const unique = (tag) => `${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;

async function church(tag) {
  const email = unique(tag);
  const { church: c } = await signupChurch({ churchName: `${tag} Church`, name: 'Owner', email, password: 'password123' });
  createdChurchIds.push(c.id);
  const tdb = tenantDb(c.id);
  const member = await tdb.member.create({ data: { firstName: `${tag}First`, lastName: `${tag}Secret` } });
  const event = await tdb.event.create({ data: { title: `${tag} service`, startsAt: new Date() } });
  return { id: c.id, email, db: tdb, member, event };
}

test.before(async () => {
  const app = createTenantApp({ pool });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  A = await church('iso-a');
  B = await church('iso-b');
});

test.after(async () => {
  server.close();
  const where = { churchId: { in: createdChurchIds } };
  await db.attendance.deleteMany({ where });
  await db.eventRsvp.deleteMany({ where });
  await db.activityLog.deleteMany({ where });
  await db.event.deleteMany({ where });
  await db.member.deleteMany({ where });
  await db.account.deleteMany({ where });
  await db.user.deleteMany({ where });
  await db.specialCategory.deleteMany({ where });
  await db.serviceType.deleteMany({ where });
  await db.expenseCategory.deleteMany({ where });
  await db.church.deleteMany({ where: { id: { in: createdChurchIds } } });
  await db.$disconnect();
  await pool.end();
});

// ---- the guard in tenantDb() -------------------------------------------------

test('a create that points at another church\'s row is refused; the church\'s own rows are fine', async () => {
  await assert.rejects(() => A.db.attendance.create({ data: { eventId: A.event.id, memberId: B.member.id } }), TenantRefError);
  await assert.rejects(() => A.db.attendance.create({ data: { eventId: B.event.id, memberId: A.member.id } }), TenantRefError);
  const ok = await A.db.attendance.create({ data: { eventId: A.event.id, memberId: A.member.id } });
  assert.strictEqual(ok.churchId, A.id);
  await A.db.attendance.delete({ where: { eventId_memberId: { eventId: A.event.id, memberId: A.member.id } } });
});

test('upsert, update, createMany and nested connect are all checked', async () => {
  await assert.rejects(() => A.db.eventRsvp.upsert({
    where: { eventId_memberId: { eventId: A.event.id, memberId: B.member.id } },
    update: {}, create: { eventId: A.event.id, memberId: B.member.id, response: 'GOING' },
  }), TenantRefError);
  await assert.rejects(() => A.db.attendance.createMany({ data: [
    { eventId: A.event.id, memberId: A.member.id },
    { eventId: A.event.id, memberId: B.member.id },
  ] }), TenantRefError);
  await assert.rejects(() => A.db.attendance.create({ data: {
    event: { connect: { id: A.event.id } }, member: { connect: { id: B.member.id } },
  } }), TenantRefError);
  const key = { eventId_memberId: { eventId: A.event.id, memberId: A.member.id } };
  await A.db.attendance.create({ data: { eventId: A.event.id, memberId: A.member.id } });
  await assert.rejects(() => A.db.attendance.update({ where: key, data: { memberId: B.member.id } }), TenantRefError);
  await A.db.attendance.delete({ where: key });
  assert.strictEqual(await db.attendance.count({ where: { churchId: A.id } }), 0, 'nothing was written');
});

test('nested creates are checked too', async () => {
  await assert.rejects(() => A.db.event.create({ data: {
    title: 'nested', startsAt: new Date(),
    attendance: { create: [{ churchId: A.id, memberId: B.member.id }] },
  } }), TenantRefError);
});

// ---- the event forms -----------------------------------------------------------

function client() {
  let cookie;
  const remember = (res) => {
    const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of set) if (c.startsWith('connect.sid=')) cookie = c.split(';')[0];
  };
  return {
    async page(p) {
      const res = await fetch(base + p, { headers: cookie ? { cookie } : {}, redirect: 'manual' });
      remember(res);
      return { status: res.status, text: await res.text() };
    },
    async login(email) {
      const res = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'password123' }) });
      remember(res);
      assert.strictEqual(res.status, 200);
    },
    async form(p, fields, from) {
      const page = await this.page(from);
      const csrf = (page.text.match(/name="_csrf" value="([^"]*)"/) || [])[1] || '';
      const res = await fetch(base + p, {
        method: 'POST', redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
        body: new URLSearchParams({ ...fields, _csrf: csrf }).toString(),
      });
      remember(res);
      return { status: res.status, location: res.headers.get('location') };
    },
  };
}

test('an admin cannot check in or RSVP another church\'s member, so their name never appears', async () => {
  const c = client();
  await c.login(A.email);
  const eventPage = `/events/${A.event.id}`;
  for (const action of ['check', 'rsvp']) {
    const res = await c.form(`${eventPage}/${action}`, { memberId: String(B.member.id), response: 'GOING' }, eventPage);
    assert.strictEqual(res.status, 302);
  }
  assert.strictEqual(await db.attendance.count({ where: { memberId: B.member.id } }), 0);
  assert.strictEqual(await db.eventRsvp.count({ where: { memberId: B.member.id } }), 0);
  const page = await c.page(eventPage);
  assert.doesNotMatch(page.text, /iso-bSecret/);

  // and the church's own member still works
  await c.form(`${eventPage}/check`, { memberId: String(A.member.id) }, eventPage);
  assert.strictEqual(await db.attendance.count({ where: { churchId: A.id, memberId: A.member.id } }), 1);
});
