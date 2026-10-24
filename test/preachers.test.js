'use strict';
// The preacher roster (S, M1, M2, lay preachers by number) and how the Preaching Plan
// uses it: appointing by code, reminders still reaching the right person, each church
// seeing only its own preachers, and the Almanac showing who preaches.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { createTenantApp } = require('../lib/tenant-http');
const { db } = require('../lib/tenant');
const { signupChurch } = require('../lib/provision');
const L = require('../lib/liturgical');
const P = require('../lib/preachers');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const PASSWORD = 'Tr0ubadour-7!';
const TAG = `p${process.pid}${Date.now().toString(36)}`;
const churchIds = [];
let server, base;

const unique = (tag) => `${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
function client() {
  let cookie;
  const remember = (res) => {
    for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) if (c.startsWith('connect.sid=')) cookie = c.split(';')[0];
  };
  const api = {
    async page(p) {
      const res = await fetch(base + p, { headers: cookie ? { cookie } : {}, redirect: 'manual' });
      remember(res);
      return { status: res.status, location: res.headers.get('location'), text: await res.text() };
    },
    async form(p, fields, from = p) {
      const csrf = ((await api.page(from)).text.match(/name="_csrf" value="([^"]*)"/) || [])[1] || '';
      const res = await fetch(base + p, {
        method: 'POST', redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
        body: new URLSearchParams({ ...fields, _csrf: csrf }).toString(),
      });
      remember(res);
      return { status: res.status, location: res.headers.get('location'), text: await res.text() };
    },
  };
  return api;
}
async function newChurch(tag) {
  const email = unique(tag);
  const { church } = await signupChurch({ churchName: `${tag} Church`, name: 'Owner', email, password: PASSWORD });
  churchIds.push(church.id);
  const admin = client();
  await admin.form('/login', { email, password: PASSWORD }, '/login');
  return { churchId: church.id, admin };
}
async function staff(churchId, role, financeRole = 'NONE') {
  const email = unique(role.toLowerCase());
  await db.user.create({ data: { churchId, username: `${role.toLowerCase()}-${Date.now()}`, email, passwordHash: await bcrypt.hash(PASSWORD, 4), role, financeRole, emailVerifiedAt: new Date() } });
  const c = client();
  await c.form('/login', { email, password: PASSWORD }, '/login');
  return c;
}

const when = new Date(Date.now() + 10 * 86400000);
const DAY = L.ymd(when);
let entry;
test.before(async () => {
  const app = createTenantApp({ pool });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  entry = await db.almanacEntry.create({ data: { serviceDate: new Date(`${DAY}T00:00:00Z`), serviceLabel: TAG, title: `Sunday ${TAG}`, colour: 'VIOLET', hymns: ['1', '2'] } });
});
test.after(async () => {
  server.close();
  await db.almanacEntry.deleteMany({ where: { serviceLabel: TAG } });
  const where = { churchId: { in: churchIds } };
  await db.preachingPlan.deleteMany({ where });
  await db.preacher.deleteMany({ where });
  await db.activityLog.deleteMany({ where });
  await db.securityAuditLog.deleteMany({ where });
  await db.account.deleteMany({ where });
  await db.user.deleteMany({ where });
  await db.specialCategory.deleteMany({ where });
  await db.serviceType.deleteMany({ where });
  await db.expenseCategory.deleteMany({ where });
  await db.church.deleteMany({ where: { id: { in: churchIds } } });
  await db.$disconnect();
  await pool.end();
});

test('codes: S, M1, M2 and lay-preacher numbers; anything else is refused; the roster sorts S, M1, M2, then by number', () => {
  const cases = { s: 'S', ' m1 ': 'M1', M2: 'M2', 7: '7', '007': '7', 12: '12', M3: null, 0: null, '': null, 'S1': null, 1234: null, '-3': null };
  for (const [input, want] of Object.entries(cases)) assert.strictEqual(P.parseCode(input), want, input);
  assert.deepStrictEqual(['10', '2', 'M2', 'S', 'M1'].map((code) => ({ code })).sort(P.byCode).map((p) => p.code), ['S', 'M1', 'M2', '2', '10']);
  assert.strictEqual(P.typeOf('M1'), 'Circuit Minister');
  assert.strictEqual(P.typeOf('4'), 'Circuit Lay Preacher');
  assert.deepStrictEqual(P.planFields({ id: 3, memberId: null, name: 'A B', phone: '0244', email: null }), { preacherId: 3, memberId: null, preacherName: 'A B', preacherPhone: '0244', preacherEmail: null });
  assert.strictEqual(P.planFields({ id: 3, memberId: 9, name: 'A B', phone: '0244' }).preacherName, null, 'a member is reached through the member record');
});

test('the roster: add by code, no duplicates, bad codes refused, only editors and admins may change it', async () => {
  const a = await newChurch('pr-a');
  const editor = await staff(a.churchId, 'EDITOR', 'TREASURER');
  const limited = await staff(a.churchId, 'EDITOR');
  const viewer = await staff(a.churchId, 'VIEWER');

  await a.admin.form('/preachers', { code: 's', name: 'Rev. Ama Mensah', phone: '0244000001' }, '/preachers');
  await a.admin.form('/preachers', { code: 'M1', name: 'Rev. Kofi Boateng' }, '/preachers');
  await editor.form('/preachers', { code: '7', name: 'Mr. Yaw Owusu', email: 'yaw@example.test' }, '/preachers');
  assert.deepStrictEqual((await db.preacher.findMany({ where: { churchId: a.churchId } })).map((p) => p.code).sort(), ['7', 'M1', 'S']);

  const dup = await a.admin.form('/preachers', { code: 'S', name: 'Someone Else' }, '/preachers');
  assert.strictEqual(dup.status, 302);
  assert.strictEqual(await db.preacher.count({ where: { churchId: a.churchId, code: 'S' } }), 1);
  await a.admin.form('/preachers', { code: 'M9', name: 'Nobody' }, '/preachers');
  assert.strictEqual(await db.preacher.count({ where: { churchId: a.churchId, name: 'Nobody' } }), 0);

  const list = await a.admin.page('/preachers');
  assert.ok(list.text.indexOf('Rev. Ama Mensah') < list.text.indexOf('Rev. Kofi Boateng') && list.text.indexOf('Rev. Kofi Boateng') < list.text.indexOf('Mr. Yaw Owusu'), 'S, M1, then the lay preachers');
  assert.match(list.text, /Superintendent Minister/);
  const asViewer = await viewer.page('/preachers');
  assert.strictEqual(asViewer.status, 200);
  assert.ok(asViewer.text.includes('Rev. Ama Mensah') && !asViewer.text.includes('0244000001'), 'a viewer sees the names, not the phone numbers');
  await viewer.form('/preachers', { code: '8', name: 'Viewer Added' }, '/preachers');
  await limited.form('/preachers', { code: '9', name: 'Limited Added' }, '/preachers');
  assert.strictEqual(await db.preacher.count({ where: { name: { in: ['Viewer Added', 'Limited Added'] } } }), 0, 'like the Preaching Plan, editing needs an admin or an editor with finance access');
  const s = await db.preacher.findFirst({ where: { churchId: a.churchId, code: 'S' } });
  assert.strictEqual((await editor.form(`/preachers/${s.id}/archive`, {}, '/preachers')).status, 403, 'taking someone off the plan is the admin\'s');
});

test('appointing by code: the plan keeps who and how to reach them, follows later changes, and refuses another church\'s preacher', async () => {
  const a = await newChurch('pr-plan-a');
  const b = await newChurch('pr-plan-b');
  await a.admin.form('/preachers', { code: '4', name: 'Mr. Kwame Asare', phone: '0244111222' }, '/preachers');
  await b.admin.form('/preachers', { code: '4', name: 'Mr. Other Church', phone: '0200000000' }, '/preachers');
  const mine = await db.preacher.findFirst({ where: { churchId: a.churchId, code: '4' } });
  const theirs = await db.preacher.findFirst({ where: { churchId: b.churchId, code: '4' } });

  await a.admin.form('/preaching', { preachDate: DAY, serviceLabel: '9:00 AM', preacherId: String(mine.id), preacherName: 'typed over' }, '/preaching');
  const plan = await db.preachingPlan.findFirst({ where: { churchId: a.churchId } });
  assert.deepStrictEqual([plan.preacherId, plan.preacherName, plan.preacherPhone, plan.memberId], [mine.id, 'Mr. Kwame Asare', '0244111222', null], 'the roster preacher replaces what was typed');

  await a.admin.form('/preaching', { preachDate: DAY, preacherId: String(theirs.id) }, '/preaching');
  assert.strictEqual(await db.preachingPlan.count({ where: { churchId: a.churchId } }), 1, 'another church\'s preacher cannot be appointed');

  // a new phone number reaches the appointments still to come
  await a.admin.form(`/preachers/${mine.id}`, { code: '4', name: 'Mr. Kwame Asare', phone: '0244999888' }, `/preachers/${mine.id}/edit`);
  assert.strictEqual((await db.preachingPlan.findUnique({ where: { id: plan.id } })).preacherPhone, '0244999888');

  // the plan page names the preacher by code, and shows what the Almanac sets for that day
  const page = await a.admin.page('/preaching');
  assert.ok(page.text.includes('Mr. Kwame Asare') && page.text.includes(`Sunday ${TAG}`) && page.text.includes('Violet'));
  // the Almanac shows who is preaching
  const alm = await a.admin.page(`/almanac?half=${(() => { const h = L.halfYearOf(DAY); return `${h.year}-${h.half}`; })()}`);
  assert.match(alm.text, /Preaching:<\/b> 4 · Mr\. Kwame Asare/);
  // the other church sees none of it
  const other = await b.admin.page('/preachers');
  assert.ok(!other.text.includes('Kwame Asare') && other.text.includes('Other Church'));

  // off the plan: not offered for new appointments, still named on the old one
  await a.admin.form(`/preachers/${mine.id}/archive`, {}, '/preachers');
  const form = await a.admin.page('/preaching');
  assert.ok(!new RegExp(`<option value="${mine.id}"[^>]*>4 · Mr`).test(form.text.split('Upcoming')[0] || ''), 'not offered once off the plan');
  await a.admin.form('/preaching', { preachDate: L.ymd(new Date(Date.now() + 17 * 86400000)), preacherId: String(mine.id) }, '/preaching');
  assert.strictEqual(await db.preachingPlan.count({ where: { churchId: a.churchId } }), 1);
  assert.strictEqual((await db.preachingPlan.findUnique({ where: { id: plan.id } })).preacherId, mine.id);
});
