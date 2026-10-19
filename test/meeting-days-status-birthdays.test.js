'use strict';
// Meeting days (Bible classes, organizations) picked from a list of days, the
// member form's statuses (Member, Visitor, Distant, Transferred, Deceased),
// and birthdays entered as a day and month without a year.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { createTenantApp } = require('../lib/tenant-http');
const { db, tenantDb } = require('../lib/tenant');
const { birthDate, fmtBirthday, dobHasYear } = require('../lib/format');
const { meetsOnFromForm, parseMeetsOn } = require('../lib/meeting-days');
const { parseBirthday, rowToMember } = require('../lib/member-import');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const churchIds = [];
let server, base;

test.before(async () => {
  const app = createTenantApp({ pool });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  server.close();
  const where = { churchId: { in: churchIds } };
  await db.activityLog.deleteMany({ where });
  await db.organizationMembership.deleteMany({ where });
  await db.organization.deleteMany({ where });
  await db.member.deleteMany({ where });
  await db.ministry.deleteMany({ where });
  await db.account.deleteMany({ where });
  await db.user.deleteMany({ where });
  await db.specialCategory.deleteMany({ where });
  await db.serviceType.deleteMany({ where });
  await db.expenseCategory.deleteMany({ where });
  await db.church.deleteMany({ where: { id: { in: churchIds } } });
  await db.$disconnect();
  await pool.end();
});

function client() {
  let cookie;
  const remember = (res) => {
    for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) if (c.startsWith('connect.sid=')) cookie = c.split(';')[0];
  };
  return {
    async json(p, body) {
      const res = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
      remember(res);
      return { status: res.status, body: await res.json() };
    },
    async get(p) {
      const res = await fetch(base + p, { headers: cookie ? { cookie } : {}, redirect: 'manual' });
      remember(res);
      return { status: res.status, location: res.headers.get('location'), text: await res.text() };
    },
    // Posts a form the way a browser does, with the CSRF token from `from`.
    async form(p, fields, from) {
      const page = await this.get(from);
      const csrf = (page.text.match(/name="_csrf" value="([^"]*)"/) || [])[1] || '';
      const res = await fetch(base + p, {
        method: 'POST', redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
        body: new URLSearchParams({ ...fields, _csrf: csrf }).toString(),
      });
      remember(res);
      await res.text();
      return { status: res.status, location: res.headers.get('location') };
    },
  };
}

async function newChurch(tag) {
  const c = client();
  const email = `${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const signup = await c.json('/signup', { churchName: `${tag} Church`, name: 'Admin', email, password: 'Tr0ubadour-7!' });
  assert.strictEqual(signup.status, 201);
  churchIds.push(signup.body.church.id);
  return { c, churchId: signup.body.church.id };
}

test('helpers: day-and-month birthdays, and meeting days to and from text', () => {
  assert.strictEqual(birthDate(3, 14), '1900-03-14');
  assert.strictEqual(birthDate(2, 29), '1904-02-29', '1900 has no 29 February');
  assert.strictEqual(birthDate(4, 31), null);
  assert.strictEqual(birthDate(3, 14, 1990), '1990-03-14', 'a real year is kept');
  assert.strictEqual(fmtBirthday('1900-03-14'), '14 March');
  assert.strictEqual(fmtBirthday('1904-02-29'), '29 February');
  assert.strictEqual(fmtBirthday(new Date('1990-03-14')), '14 March 1990');
  assert.strictEqual(dobHasYear('1904-02-29'), false);

  assert.strictEqual(meetsOnFromForm({ meetsDay: 'Sunday', meetsTime: '16:30' }), 'Sunday, 4:30 PM');
  assert.strictEqual(meetsOnFromForm({ meetsDay: 'Monday', meetsTime: '' }), 'Monday');
  assert.strictEqual(meetsOnFromForm({ meetsDay: 'Funday' }), null);
  assert.strictEqual(meetsOnFromForm({ meetsDay: '__keep__' }, 'Saturday 5pm'), 'Saturday 5pm');
  assert.deepStrictEqual(parseMeetsOn('Sunday, 12:05 AM'), { day: 'Sunday', time: '00:05' });
  assert.deepStrictEqual(parseMeetsOn('Saturday 5pm'), { day: null, time: '' });

  assert.strictEqual(parseBirthday('14 March'), '1900-03-14');
  assert.strictEqual(parseBirthday('March 14th'), '1900-03-14');
  assert.strictEqual(parseBirthday('12/03/1990'), '1990-03-12');
});

test('import: a birthday without a year is kept, and gives no day born', () => {
  const { data } = rowToMember(['Ama', 'Owusu', '14 March', 'Distant'], ['firstName', 'lastName', 'dateOfBirth', 'membershipStatus']);
  assert.strictEqual(data.dateOfBirth, '1900-03-14');
  assert.strictEqual(data.dayBorn ?? null, null, 'the weekday of 14 March 1900 is not the member\'s');
  assert.strictEqual(data.membershipStatus, 'DISTANT');
});

test('Bible classes: meeting days are picked from the days, editable, and old text is kept until changed', async () => {
  const { c, churchId } = await newChurch('meet-class');
  const page = await c.get('/bible-classes');
  assert.match(page.text, /<select name="meetsDay">/);
  assert.match(page.text, /Meeting days/);
  assert.doesNotMatch(page.text, /name="meetsOn"/);

  assert.strictEqual((await c.form('/bible-classes', { name: 'Class A', meetsDay: 'Sunday', meetsTime: '08:00' }, '/bible-classes')).status, 302);
  const cls = await tenantDb(churchId).ministry.findFirst({ where: { name: 'Class A' } });
  assert.strictEqual(cls.meetsOn, 'Sunday, 8:00 AM');

  // An older free-text value survives saving the row's other fields...
  await tenantDb(churchId).ministry.update({ where: { id: cls.id }, data: { meetsOn: 'Saturday 5pm' } });
  const list = await c.get('/bible-classes');
  assert.match(list.text, /<option value="__keep__" selected>Saturday 5pm<\/option>/);
  await c.form(`/bible-classes/${cls.id}`, { leaderId: '', orgId: '', meetsDay: '__keep__', meetsTime: '' }, '/bible-classes');
  assert.strictEqual((await tenantDb(churchId).ministry.findUnique({ where: { id: cls.id } })).meetsOn, 'Saturday 5pm');
  // ...and is replaced once a day is picked.
  await c.form(`/bible-classes/${cls.id}`, { leaderId: '', orgId: '', meetsDay: 'Wednesday', meetsTime: '18:30' }, '/bible-classes');
  assert.strictEqual((await tenantDb(churchId).ministry.findUnique({ where: { id: cls.id } })).meetsOn, 'Wednesday, 6:30 PM');
  assert.match((await c.get('/bible-classes')).text, /Wednesday, 6:30 PM/);
});

test('organizations: meeting days on creation and from the organization\'s page', async () => {
  const { c, churchId } = await newChurch('meet-org');
  assert.match((await c.get('/organizations/new')).text, /<select name="meetsDay">/);
  assert.strictEqual((await c.form('/organizations', { name: 'Choir', meetsDay: 'Thursday', meetsTime: '18:00' }, '/organizations/new')).status, 302);
  const org = await tenantDb(churchId).organization.findFirst({ where: { name: 'Choir' } });
  assert.strictEqual(org.meetsOn, 'Thursday, 6:00 PM');

  const detail = await c.get(`/organizations/${org.id}`);
  assert.match(detail.text, /Meeting days/);
  assert.match(detail.text, /action="\/organizations\/\d+\/meeting"/);
  const saved = await c.form(`/organizations/${org.id}/meeting`, { meetsDay: 'Saturday', meetsTime: '' }, `/organizations/${org.id}`);
  assert.strictEqual(saved.status, 302);
  assert.strictEqual((await tenantDb(churchId).organization.findUnique({ where: { id: org.id } })).meetsOn, 'Saturday');

  // Another church cannot change it.
  const { c: other } = await newChurch('meet-org-other');
  const refused = await other.form(`/organizations/${org.id}/meeting`, { meetsDay: 'Monday' }, '/organizations');
  assert.strictEqual(refused.status, 404);
  assert.strictEqual((await tenantDb(churchId).organization.findUnique({ where: { id: org.id } })).meetsOn, 'Saturday');
});

test('members: five statuses on the form, Distant saved, birthdays without a year', async () => {
  const { c, churchId } = await newChurch('member-dob');
  const form = (await c.get('/members/new')).text;
  const offered = [...form.match(/<select name="membershipStatus"[\s\S]*?<\/select>/)[0].matchAll(/<option value="([A-Z]+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(offered, ['MEMBER', 'VISITOR', 'DISTANT', 'TRANSFERRED', 'DECEASED']);
  assert.match(form, /name="dobDay"/);
  assert.match(form, /name="dobMonth"/);
  assert.doesNotMatch(form, /type="date" name="dateOfBirth"/);

  const base = { lastName: 'Mensah', mobilePhone: '0244000155', gender: 'F', preferredChannel: 'NONE' };
  const created = await c.form('/members', { ...base, firstName: 'Ama', membershipStatus: 'DISTANT', dobDay: '14', dobMonth: '3' }, '/members/new');
  assert.strictEqual(created.status, 302);
  const id = Number(created.location.match(/\/members\/(\d+)/)[1]);
  let m = await tenantDb(churchId).member.findUnique({ where: { id } });
  assert.strictEqual(m.membershipStatus, 'DISTANT');
  assert.strictEqual(m.dateOfBirth.toISOString().slice(0, 10), '1900-03-14');
  const profile = (await c.get(`/members/${id}`)).text;
  assert.match(profile, /14 March/);
  assert.doesNotMatch(profile, /1900/);

  // 29 February works; 31 April and a day without a month are refused.
  const leap = await c.form('/members', { ...base, firstName: 'Kojo', membershipStatus: 'MEMBER', dobDay: '29', dobMonth: '2' }, '/members/new');
  const leapId = Number(leap.location.match(/\/members\/(\d+)/)[1]);
  assert.strictEqual((await tenantDb(churchId).member.findUnique({ where: { id: leapId } })).dateOfBirth.toISOString().slice(0, 10), '1904-02-29');
  for (const bad of [{ dobDay: '31', dobMonth: '4' }, { dobDay: '5', dobMonth: '' }]) {
    const r = await c.form('/members', { ...base, firstName: 'Nope', membershipStatus: 'MEMBER', ...bad }, '/members/new');
    assert.strictEqual(r.location, '/members/new');
  }
  assert.strictEqual(await tenantDb(churchId).member.count({ where: { firstName: 'Nope' } }), 0);

  // A year already on file (import or API) is kept when the form is saved,
  // and an old status stays selectable for that member.
  await tenantDb(churchId).member.update({ where: { id }, data: { dateOfBirth: new Date('1990-03-14'), membershipStatus: 'REGULAR' } });
  const edit = (await c.get(`/members/${id}`)).text;
  assert.match(edit, /<input type="hidden" name="dobYear" value="1990">/);
  assert.match(edit, /<option value="REGULAR" selected>Regular<\/option>/);
  await c.form(`/members/${id}`, { ...base, firstName: 'Ama', membershipStatus: 'REGULAR', dobDay: '15', dobMonth: '3', dobYear: '1990' }, `/members/${id}`);
  m = await tenantDb(churchId).member.findUnique({ where: { id } });
  assert.strictEqual(m.dateOfBirth.toISOString().slice(0, 10), '1990-03-15');
  assert.strictEqual(m.membershipStatus, 'REGULAR');

  // The export writes a yearless birthday as "14 March", which imports back.
  await tenantDb(churchId).member.update({ where: { id }, data: { dateOfBirth: new Date('1900-03-14T00:00:00Z') } });
  const csv = (await c.get('/members/export.csv')).text;
  assert.match(csv, /Ama,Mensah,Regular,[^\n]*,14 March,/);
  assert.match((await c.get('/members?status=DISTANT')).text, /Distant/);
});

test('members: the emergency contact relationship is picked from a list; older typed values are kept', async () => {
  const { c, churchId } = await newChurch('member-relation');
  const form = (await c.get('/members/new')).text;
  const select = form.match(/<select name="emergencyContactRelation">[\s\S]*?<\/select>/);
  assert.ok(select, 'a dropdown, not a text box');
  assert.deepStrictEqual([...select[0].matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]),
    ['', 'Spouse', 'Parent', 'Child', 'Sibling', 'Other relative', 'Guardian', 'Friend', 'Other']);

  const base = { firstName: 'Efua', lastName: 'Ansah', mobilePhone: '0244000166', gender: 'F', preferredChannel: 'NONE', membershipStatus: 'MEMBER' };
  const created = await c.form('/members', { ...base, emergencyContactName: 'Kofi Ansah', emergencyContactRelation: 'Spouse' }, '/members/new');
  const id = Number(created.location.match(/\/members\/(\d+)/)[1]);
  assert.strictEqual((await tenantDb(churchId).member.findUnique({ where: { id } })).emergencyContactRelation, 'Spouse');

  // Typed before the list existed: matched case-insensitively, or kept as it is.
  await tenantDb(churchId).member.update({ where: { id }, data: { emergencyContactRelation: 'sibling' } });
  assert.match((await c.get(`/members/${id}`)).text, /<option value="Sibling" selected>Sibling<\/option>/);
  await tenantDb(churchId).member.update({ where: { id }, data: { emergencyContactRelation: 'Uncle' } });
  const edit = (await c.get(`/members/${id}`)).text;
  assert.match(edit, /<option value="Uncle" selected>Uncle<\/option>/);
  await c.form(`/members/${id}`, { ...base, emergencyContactName: 'Kofi Ansah', emergencyContactRelation: 'Uncle' }, `/members/${id}`);
  assert.strictEqual((await tenantDb(churchId).member.findUnique({ where: { id } })).emergencyContactRelation, 'Uncle');
});
