'use strict';
// Phase 8d verification: thin HTTP smoke tests for the two new HTML modules
// (members, reports) — same pattern as the earlier phase8*-html.test.js files.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { createTenantApp } = require('../lib/tenant-http');
const { db } = require('../lib/tenant');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const createdChurchIds = [];

let server, base;
test.before(async () => {
  const app = createTenantApp({ pool });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  server.close();
  if (createdChurchIds.length) {
    const where = { churchId: { in: createdChurchIds } };
    await db.activityLog.deleteMany({ where });
    await db.organizationMembership.deleteMany({ where });
    await db.tithe.deleteMany({ where });
    await db.dayBornSplit.deleteMany({ where });
    await db.service.deleteMany({ where });
    await db.serviceType.deleteMany({ where });
    await db.expenseCategory.deleteMany({ where });
    await db.member.deleteMany({ where });
    await db.account.deleteMany({ where });
    await db.user.deleteMany({ where });
    await db.specialCategory.deleteMany({ where });
    await db.church.deleteMany({ where: { id: { in: createdChurchIds } } });
  }
  await db.$disconnect();
  await pool.end();
});

function htmlClient() {
  let cookie;
  const remember = (res) => {
    const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of set) if (c.startsWith('connect.sid=')) cookie = c.split(';')[0];
  };
  return {
    async postJson(p, jsonBody) {
      const res = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(jsonBody) });
      remember(res);
      return { status: res.status, body: await res.json() };
    },
    async getHtml(p) {
      const res = await fetch(base + p, { headers: cookie ? { cookie } : {}, redirect: 'manual' });
      remember(res);
      return { status: res.status, location: res.headers.get('location'), text: res.status < 300 ? await res.text() : '' };
    },
    async postForm(p, form) {
      const res = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(form).toString(), redirect: 'manual' });
      remember(res);
      return { status: res.status, location: res.headers.get('location') };
    },
  };
}

function uniqueEmail(tag) {
  return `${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
}
function extractCsrf(html) {
  const m = html.match(/name="_csrf" value="([^"]*)"/);
  return m ? m[1] : null;
}
async function signedInClient(tag) {
  const client = htmlClient();
  const signup = await client.postJson('/signup', { churchName: `${tag} Church`, name: 'Admin Person', email: uniqueEmail(tag), password: 'Tr0ubadour-7!' });
  assert.strictEqual(signup.status, 201);
  createdChurchIds.push(signup.body.church.id);
  // The /reports pages are a Pro feature. These tests cover what the pages
  // render, not the plan gate — that has its own coverage in
  // test/plan-limits.test.js.
  await db.church.update({ where: { id: signup.body.church.id }, data: { plan: 'pro' } });
  return { client, churchId: signup.body.church.id };
}

for (const [path, title] of [['/members', 'Members'], ['/reports', 'Reports']]) {
  test(`unauthenticated GET ${path} redirects to /login`, async () => {
    const client = htmlClient();
    const res = await client.getHtml(path);
    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.location, '/login');
  });

  test(`signed-in GET ${path} renders 200 with a CSRF token and the right title`, async () => {
    const { client } = await signedInClient(`html-smoke-${path.replace('/', '')}`);
    const res = await client.getHtml(path);
    assert.strictEqual(res.status, 200);
    assert.match(res.text, new RegExp(title));
    assert.ok(extractCsrf(res.text), 'expected a CSRF token embedded in the rendered page');
  });
}

test('members: profile panel is church-scoped, and the directory filters take several values', async () => {
  const { client } = await signedInClient('html-mem-panel');
  const csrf = extractCsrf((await client.getHtml('/members/new')).text);
  const created = await client.postForm('/members', {
    firstName: 'Esi', lastName: 'Quaye', mobilePhone: '0244000077', gender: 'F', membershipStatus: 'MEMBER', preferredChannel: 'EITHER', dayBorn: 'Sunday', _csrf: csrf,
  });
  assert.strictEqual(created.status, 302);
  const memberId = created.location.match(/\/members\/(\d+)/)[1];

  const panel = await client.getHtml(`/members/${memberId}/panel`);
  assert.strictEqual(panel.status, 200);
  assert.match(panel.text, /Esi Quaye/);
  assert.match(panel.text, /Open full profile/);
  assert.doesNotMatch(panel.text, /<html/i, 'the panel is a fragment, not a full page');

  // Another church cannot read it, and a bad id is simply not found.
  const { client: other } = await signedInClient('html-mem-panel-other');
  assert.strictEqual((await other.getHtml(`/members/${memberId}/panel`)).status, 404);
  assert.strictEqual((await client.getHtml('/members/not-a-number/panel')).status, 404);
  assert.strictEqual((await htmlClient().getHtml(`/members/${memberId}/panel`)).status, 401);

  // Repeated query values are ORed within a filter.
  assert.match((await client.getHtml('/members?status=VISITOR&status=MEMBER')).text, /Esi Quaye/);
  assert.doesNotMatch((await client.getHtml('/members?status=VISITOR')).text, /Esi Quaye/);
  assert.match((await client.getHtml('/members?day_born=Monday&day_born=Sunday')).text, /Esi Quaye/);
  assert.doesNotMatch((await client.getHtml('/members?day_born=Monday')).text, /Esi Quaye/);
  // Day born is a checkbox list marked pick-one, with a count beside each day.
  const directory = (await client.getHtml('/members?day_born=Sunday')).text;
  assert.match(directory, /<div class="pm-fg" data-pick-one><h3>Day born<\/h3>/);
  assert.match(directory, /<input type="checkbox" name="day_born" value="Sunday" checked><span>Sunday<\/span><small>1<\/small>/);
  // Other churches' members never leak into the directory.
  assert.doesNotMatch((await other.getHtml('/members')).text, /Esi Quaye/);
});

test('members: CSV export and selected-member SMS stay inside the church', async () => {
  const add = async (client, firstName, lastName, membershipStatus) => {
    const csrf = extractCsrf((await client.getHtml('/members/new')).text);
    const r = await client.postForm('/members', { firstName, lastName, mobilePhone: '0244000123', gender: 'M', membershipStatus, preferredChannel: 'EITHER', _csrf: csrf });
    assert.strictEqual(r.status, 302);
    return r.location.match(/\/members\/(\d+)/)[1];
  };
  const { client } = await signedInClient('html-mem-bulk');
  const a1 = await add(client, 'Yaw', 'Darko', 'MEMBER');
  const a2 = await add(client, 'Ama', 'Serwaa', 'VISITOR');
  const { client: other } = await signedInClient('html-mem-bulk-other');
  const b1 = await add(other, 'Kwesi', 'Outsider', 'MEMBER');

  // Everyone matching the filters...
  const all = await client.getHtml('/members/export.csv?status=MEMBER');
  assert.strictEqual(all.status, 200);
  assert.match(all.text, /^Member ID,First name,Last name,Status/);
  assert.match(all.text, /Yaw,Darko,Member/);
  assert.doesNotMatch(all.text, /Serwaa/, 'the status filter applies to the export');
  assert.doesNotMatch(all.text, /Outsider/);
  // ...or exactly the selection, where another church's id finds nothing.
  const picked = await client.getHtml(`/members/export.csv?ids=${a2},${b1}`);
  assert.match(picked.text, /Ama,Serwaa,Visitor/);
  assert.doesNotMatch(picked.text, /Darko|Outsider/);
  assert.strictEqual((await htmlClient().getHtml('/members/export.csv')).status, 403);

  const compose = await client.getHtml(`/communications/broadcast?member_ids=${a1},${a2},${b1}`);
  assert.strictEqual(compose.status, 200);
  assert.match(compose.text, /Audience preview · 2 members/);
  assert.match(compose.text, new RegExp(`name="member_ids" value="${a1},${a2}"`), 'only this church\'s members are carried into the send');
  assert.doesNotMatch(compose.text, /Outsider/);
});

test('members: create without CSRF is rejected, with CSRF succeeds, edit and archive', async () => {
  const { client } = await signedInClient('html-mem-create');
  const newPage = await client.getHtml('/members/new');
  const csrf = extractCsrf(newPage.text);

  const rejected = await client.postForm('/members', { firstName: 'No', lastName: 'Csrf', mobilePhone: '0244000099' });
  assert.strictEqual(rejected.status, 403);

  const created = await client.postForm('/members', {
    firstName: 'Kofi', lastName: 'Mensah', mobilePhone: '0244000001', gender: 'M', membershipStatus: 'MEMBER', preferredChannel: 'EITHER', _csrf: csrf,
  });
  assert.strictEqual(created.status, 302);
  assert.match(created.location, /\/members\/\d+/);
  const memberId = created.location.match(/\/members\/(\d+)/)[1];

  const list = await client.getHtml('/members');
  assert.match(list.text, /Kofi Mensah/);
  assert.match(list.text, /MBR-001/);

  const detail = await client.getHtml(`/members/${memberId}`);
  assert.strictEqual(detail.status, 200);
  assert.match(detail.text, /Kofi/);
  const csrf2 = extractCsrf(detail.text);

  const edited = await client.postForm(`/members/${memberId}`, {
    firstName: 'Kofi', lastName: 'Mensah-Updated', mobilePhone: '0244000001', gender: 'M', membershipStatus: 'MEMBER', preferredChannel: 'EITHER', _csrf: csrf2,
  });
  assert.strictEqual(edited.status, 302);
  const afterEdit = await client.getHtml(`/members/${memberId}`);
  assert.match(afterEdit.text, /Mensah-Updated/);

  const csrf3 = extractCsrf(afterEdit.text);
  const archived = await client.postForm(`/members/${memberId}/delete`, { _csrf: csrf3 });
  assert.strictEqual(archived.status, 302);
  const afterArchive = await client.getHtml('/members');
  assert.doesNotMatch(afterArchive.text, /Mensah-Updated/);
});

test('reports: day-born, income, and members reports render with real data across the raw SQL joins', async () => {
  const { client, churchId } = await signedInClient('html-rep-data');
  // 'Sunday Service' is already seeded per-church at signup (Phase 9e) — look it up rather than re-create it.
  const svcType = await db.serviceType.findFirst({ where: { churchId, typeName: 'Sunday Service' } });
  const svc = await db.service.create({ data: { churchId, serviceTypeId: svcType.id, serviceDate: new Date(), totalAmount: 500 } });
  await db.dayBornSplit.create({ data: { churchId, serviceId: svc.id, dayBorn: 'MONDAY', amount: 200 } });
  const member = await db.member.create({
    data: {
      churchId,
      externalId: 'MBR-001',
      firstName: 'Ama',
      lastName: 'Owusu',
      membershipStatus: 'MEMBER',
      unsubscribeToken: `tok-rep-1-${process.pid}-${Date.now()}`,
    },
  });
  await db.tithe.create({ data: { churchId, memberId: member.id, amount: 100, titheDate: new Date() } });

  const dayBorn = await client.getHtml('/reports/day-born');
  assert.strictEqual(dayBorn.status, 200);
  assert.match(dayBorn.text, /MONDAY/);

  const income = await client.getHtml('/reports/income');
  assert.strictEqual(income.status, 200);
  assert.match(income.text, /Ama Owusu/);
  assert.match(income.text, /Tithe/);

  const members = await client.getHtml('/reports/members');
  assert.strictEqual(members.status, 200);
  assert.match(members.text, /MEMBER/);
});
