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
  const { church: c } = await signupChurch({ churchName: `${tag} Church`, name: 'Owner', email, password: 'Tr0ubadour-7!' });
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
      const res = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'Tr0ubadour-7!' }) });
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

// ---- a write may only ever name its own church --------------------------------
// Found by attacking the layer directly (the review of cross-church access).
// No route passes request data into a write, so none of these was reachable,
// but each would have silently broken isolation the day one did.

test('a write cannot hand a row to another church, however it names the church', async () => {
  const mine = await A.db.member.create({ data: { firstName: 'Stay', lastName: 'Put' } });
  for (const [label, run] of [
    ['update churchId', () => A.db.member.update({ where: { id: mine.id }, data: { churchId: B.id } })],
    ['update churchId {set}', () => A.db.member.update({ where: { id: mine.id }, data: { churchId: { set: B.id } } })],
    ['updateMany churchId', () => A.db.member.updateMany({ where: { id: mine.id }, data: { churchId: B.id } })],
    ['update church connect', () => A.db.member.update({ where: { id: mine.id }, data: { church: { connect: { id: B.id } } } })],
    ['upsert update churchId', () => A.db.member.upsert({ where: { id: mine.id }, create: { firstName: 'x', lastName: 'y' }, update: { churchId: B.id } })],
    ['create churchId', () => A.db.member.create({ data: { firstName: 'Plant', lastName: 'Create', churchId: B.id } })],
    ['createMany churchId', () => A.db.member.createMany({ data: [{ firstName: 'Plant', lastName: 'Many', churchId: B.id }] })],
    ['createManyAndReturn churchId', () => A.db.member.createManyAndReturn({ data: [{ firstName: 'Plant', lastName: 'Return', churchId: B.id }] })],
    ['nested create churchId', () => A.db.event.create({ data: { title: 'x', startsAt: new Date(), attendance: { create: { memberId: mine.id, churchId: B.id } } } })],
  ]) {
    await assert.rejects(run, TenantRefError, label);
  }
  assert.strictEqual((await db.member.findUnique({ where: { id: mine.id } })).churchId, A.id, 'the row never left its church');
  assert.strictEqual(await db.member.count({ where: { churchId: B.id, lastName: { in: ['Create', 'Many', 'Return'] } } }), 0, 'nothing was planted in the other church');
  assert.strictEqual(await db.attendance.count({ where: { churchId: B.id, memberId: mine.id } }), 0);
  // naming its own church is harmless
  const own = await A.db.member.update({ where: { id: mine.id }, data: { churchId: A.id, firstName: 'Still' } });
  assert.strictEqual(own.firstName, 'Still');
});

test('the newer operations are scoped like the older ones', async () => {
  const before = await db.member.findUnique({ where: { id: B.member.id } });
  const changed = await A.db.member.updateManyAndReturn({ where: { id: B.member.id }, data: { firstName: 'HACKED' } });
  assert.deepStrictEqual(changed, [], "updateManyAndReturn does not reach another church's row");
  assert.strictEqual((await db.member.findUnique({ where: { id: B.member.id } })).firstName, before.firstName);
  const made = await A.db.member.createManyAndReturn({ data: [{ firstName: 'Made', lastName: 'InA' }] });
  assert.strictEqual(made[0].churchId, A.id);
});

test('a scoped client needs a church: none given must fail, not return every church', () => {
  for (const bad of [undefined, null, '', 0, {}, 123]) assert.throws(() => tenantDb(bad), /needs a church id/, String(bad));
});

test('reads and writes by id never cross churches, with any filter trick', async () => {
  const id = B.member.id;
  assert.strictEqual(await A.db.member.findUnique({ where: { id } }), null);
  assert.strictEqual(await A.db.member.findFirst({ where: { id, churchId: B.id } }), null, 'a churchId in where is overridden, not honoured');
  assert.deepStrictEqual(await A.db.member.findMany({ where: { OR: [{ churchId: B.id }, { id }] } }).then((r) => r.filter((m) => m.churchId !== A.id)), []);
  assert.strictEqual((await A.db.member.findMany({ where: { NOT: { churchId: A.id } } })).length, 0);
  assert.strictEqual(await A.db.member.count({ where: { id } }), 0);
  assert.strictEqual((await A.db.member.aggregate({ _count: true, where: { id } }))._count, 0);
  await assert.rejects(() => A.db.member.update({ where: { id }, data: { firstName: 'X' } }));
  await assert.rejects(() => A.db.member.delete({ where: { id } }));
  assert.strictEqual((await A.db.member.updateMany({ where: { id }, data: { firstName: 'X' } })).count, 0);
  assert.strictEqual((await A.db.member.deleteMany({ where: { id } })).count, 0);
  assert.ok(await db.member.findUnique({ where: { id } }), 'the row is untouched');
});
