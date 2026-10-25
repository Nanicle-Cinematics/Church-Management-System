'use strict';
// Members > Import (routes-pg-html/member-import.js, lib/member-import.js):
// upload a CSV or Excel file, check the preview, import.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const XLSX = require('xlsx');
const { Prisma } = require('@prisma/client');
const { createTenantApp } = require('../lib/tenant-http');
const { db } = require('../lib/tenant');
const { signupChurch } = require('../lib/provision');
const imp = require('../lib/member-import');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const churchIds = [];
let server, base;

const unique = (tag) => `${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;

function client() {
  let cookie;
  const remember = (res) => {
    for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) if (c.startsWith('connect.sid=')) cookie = c.split(';')[0];
  };
  const csrf = async (from) => ((await self.get(from)).text.match(/name="_csrf" value="([^"]*)"/) || [])[1] || '';
  const self = {
    async get(p) {
      const res = await fetch(base + p, { headers: cookie ? { cookie } : {}, redirect: 'manual' });
      remember(res);
      return { status: res.status, location: res.headers.get('location'), text: await res.text() };
    },
    async json(p, body) {
      const res = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
      remember(res);
      return { status: res.status };
    },
    async upload(name, content) {
      const fd = new FormData();
      fd.append('_csrf', await csrf('/members/import'));
      fd.append('file', new Blob([content]), name);
      const res = await fetch(`${base}/members/import`, { method: 'POST', body: fd, redirect: 'manual', headers: cookie ? { cookie } : {} });
      remember(res);
      await res.text();
      return { status: res.status, location: res.headers.get('location') };
    },
    async importIt(previewPath) {
      const page = await self.get(previewPath);
      const fields = new URLSearchParams();
      const form = page.text.slice(page.text.indexOf('class="mi-go"'));
      for (const m of form.slice(0, form.indexOf('</form>')).matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) fields.append(m[1], m[2].replace(/&amp;/g, '&'));
      if (!fields.has('_csrf')) fields.append('_csrf', await csrf('/members/import')); // e.g. a second press after importing
      const res = await fetch(base + previewPath.split('?')[0], { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) }, body: fields.toString() });
      remember(res);
      await res.text();
      return { status: res.status, location: res.headers.get('location') };
    },
  };
  return self;
}

async function signIn(email) {
  const c = client();
  assert.strictEqual((await c.json('/login', { email, password: 'Tr0ubadour-7!' })).status, 200);
  return c;
}

async function newChurch(tag) {
  const email = unique(tag);
  const { church } = await signupChurch({ churchName: `${tag} Church`, name: 'Owner', email, password: 'Tr0ubadour-7!' });
  churchIds.push(church.id);
  return { churchId: church.id, admin: await signIn(email) };
}

test.before(async () => {
  const app = createTenantApp({ pool });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  server.close();
  const models = Prisma.dmmf.datamodel.models
    .filter((m) => m.name !== 'Church' && m.fields.some((f) => f.name === 'churchId'))
    .map((m) => m.name[0].toLowerCase() + m.name.slice(1));
  const where = { churchId: { in: churchIds } };
  for (let pass = 0; pass < 20; pass++) {
    let blocked = false;
    for (const m of models) {
      try { await db[m].deleteMany({ where }); } catch (e) { if (e.code === 'P2003') blocked = true; else throw e; }
    }
    if (!blocked) break;
  }
  await db.church.deleteMany({ where: { id: { in: churchIds } } });
  await db.$disconnect();
  await pool.end();
});

test('values are read the way a Ghanaian spreadsheet writes them', () => {
  assert.strictEqual(imp.parseDate('12/03/1990'), '1990-03-12', 'day first');
  assert.strictEqual(imp.parseDate('12 Mar 1990'), '1990-03-12');
  assert.strictEqual(imp.parseDate('31/02/1990'), null);
  assert.deepStrictEqual(imp.splitName('Rev. Kwame Mensah Asante'), { firstName: 'Kwame', lastName: 'Mensah Asante' });
  assert.deepStrictEqual(imp.guessMapping(['Surname', 'Other Names', 'Sex', 'D.O.B', 'Tel.', 'Class']),
    ['lastName', 'firstName', 'gender', 'dateOfBirth', 'mobilePhone', 'bibleClass']);
  const r = imp.rowToMember(['AMA', 'MENSAH', 'female', '01/01/1990', 'Married', 'n/a'], ['firstName', 'lastName', 'gender', 'dateOfBirth', 'maritalStatus', 'email']);
  assert.strictEqual(r.data.firstName, 'Ama');
  assert.strictEqual(r.data.gender, 'F');
  assert.strictEqual(r.data.dayBorn, 'Monday', 'worked out from the date of birth');
  assert.match(r.problems.join(), /email "n\/a" not valid/);
});

test('a CSV is previewed, then imported with Bible classes and organisations; repeats and bad rows are skipped', async () => {
  const { churchId, admin } = await newChurch('imp-csv');
  await db.member.create({ data: { churchId, firstName: 'Old', lastName: 'Member', mobilePhone: '0244000111' } });
  const csv = [
    'Name,Sex,Date of Birth,Phone,Email,Class,Organisations,Status',
    'Ama Serwaa Mensah,F,12/03/1990,024 412 7781,AMA@example.com,Wesley Class,"Choir; Women\'s Fellowship",Member',
    'Kofi Boateng,Male,1985-07-05,0201112223,,Wesley Class,Choir,',
    'Yaw Duplicate,M,,+233 24 400 0111,,,,', // same phone as Old Member
    'Akua Again,F,12/03/1990,0244127781,,,,', // same phone as row 2
    'Madonna,,,,,,,', // one name only
  ].join('\n');
  const up = await admin.upload('members.csv', csv);
  assert.strictEqual(up.status, 302);
  assert.match(up.location, /^\/members\/import\/\d+$/);

  const preview = await admin.get(up.location);
  assert.strictEqual(preview.status, 200);
  assert.match(preview.text, /Import 2 members/);
  assert.match(preview.text, /already in the church \(same phone number\)/);
  assert.match(preview.text, /repeats an earlier row \(same phone number\)/);
  assert.match(preview.text, /Needs both a first and a last name/);
  assert.strictEqual(await db.member.count({ where: { churchId } }), 1, 'the preview adds nothing');

  const done = await admin.importIt(up.location);
  assert.strictEqual(done.status, 302);
  assert.strictEqual(done.location, '/members');
  assert.match((await admin.get('/members')).text, /2 members imported, with 1 new Bible class and 2 new organisations\. 3 rows were skipped\./);

  const ama = await db.member.findFirst({ where: { churchId, firstName: 'Ama' }, include: { bibleClass: true, orgMemberships: { include: { organization: true } } } });
  assert.strictEqual(ama.lastName, 'Serwaa Mensah');
  assert.strictEqual(ama.email, 'ama@example.com');
  assert.strictEqual(ama.dateOfBirth.toISOString().slice(0, 10), '1990-03-12');
  assert.strictEqual(ama.membershipStatus, 'MEMBER');
  assert.strictEqual(ama.preferredChannel, 'EITHER');
  assert.strictEqual(ama.bibleClass.name, 'Wesley Class');
  assert.deepStrictEqual(ama.orgMemberships.map((o) => o.organization.name).sort(), ['Choir', "Women's Fellowship"]);
  assert.match(ama.externalId, /^MBR-\d{3}$/);
  assert.ok(ama.unsubscribeToken);
  const kofi = await db.member.findFirst({ where: { churchId, firstName: 'Kofi' } });
  assert.strictEqual(kofi.membershipStatus, 'MEMBER', 'no status in the file: the chosen default');
  assert.notStrictEqual(kofi.externalId, ama.externalId);
  assert.strictEqual(await db.ministry.count({ where: { churchId, name: 'Wesley Class' } }), 1);
  assert.strictEqual(await db.memberImport.count({ where: { churchId } }), 0, 'the upload is gone once imported');

  assert.strictEqual((await admin.importIt(up.location)).status, 302);
  assert.strictEqual(await db.member.count({ where: { churchId } }), 3, 'pressing Import again adds nobody');
  const again = await admin.upload('members.csv', csv);
  assert.match((await admin.get(again.location)).text, /<div class="hs-value">0<\/div><div class="hs-label">Ready to import/, 'the same file again: nothing new');
});

test('an Excel file with real date cells and member IDs; columns can be re-matched before importing', async () => {
  const { churchId, admin } = await newChurch('imp-xlsx');
  const ws = XLSX.utils.aoa_to_sheet([
    ['Member ID', 'Surname', 'Other names', 'Date of birth', 'Mobile', 'Remarks'],
    ['DMS-0042', 'Asante', 'Kwame', new Date(Date.UTC(1978, 10, 4)), '0277000001', 'Usher'],
    ['', 'Owusu', 'Efua', new Date(Date.UTC(2001, 0, 31)), '0277000002', 'Do not import this'],
  ], { cellDates: true });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Members');
  for (const [ext, bookType] of [['xlsx', 'xlsx'], ['xls', 'biff8']]) {
    const up = await admin.upload(`members.${ext}`, XLSX.write(wb, { type: 'buffer', bookType }));
    assert.strictEqual(up.status, 302, ext);
    const preview = await admin.get(up.location);
    assert.match(preview.text, /<option value="notes" selected>/, `${ext}: Remarks guessed as notes`);
    if (ext === 'xls') { // the .xlsx run already imported them
      assert.match(preview.text, /already in the church/, 'the same people as a .xls are recognised');
      continue;
    }
    // Re-match "Remarks" to "Don't import".
    const remapped = `${up.location}?map0=externalId&map1=lastName&map2=firstName&map3=dateOfBirth&map4=mobilePhone&map5=&status=REGULAR&channel=SMS_ONLY&createGroups=1`;
    assert.strictEqual((await admin.importIt(remapped)).status, 302);
  }
  const kwame = await db.member.findFirst({ where: { churchId, firstName: 'Kwame' } });
  assert.strictEqual(kwame.externalId, 'DMS-0042', 'the file\'s own ID is kept');
  assert.strictEqual(kwame.dateOfBirth.toISOString().slice(0, 10), '1978-11-04');
  assert.strictEqual(kwame.dayBorn, 'Saturday');
  assert.strictEqual(kwame.membershipStatus, 'REGULAR');
  assert.strictEqual(kwame.preferredChannel, 'SMS_ONLY');
  assert.strictEqual(kwame.notes, null, 'the column set to Don\'t import was left out');
  const efua = await db.member.findFirst({ where: { churchId, firstName: 'Efua' } });
  assert.match(efua.externalId, /^MBR-\d{3}$/);
});

test('only admins can import, only their own upload, and bad files are refused politely', async () => {
  const { churchId, admin } = await newChurch('imp-perm');
  const email = unique('editor');
  await db.user.create({ data: { churchId, username: `ed-${Date.now()}`, email, passwordHash: await bcrypt.hash('Tr0ubadour-7!', 4), role: 'EDITOR', financeRole: 'CASHIER' } });
  const editor = await signIn(email);
  assert.strictEqual((await editor.get('/members/import')).status, 403);
  assert.doesNotMatch((await editor.get('/members')).text, /href="\/members\/import"/);
  assert.match((await admin.get('/members')).text, /href="\/members\/import"/);

  const up = await admin.upload('a.csv', 'First name,Last name\nAma,Mensah\n');
  const other = await newChurch('imp-other');
  const peek = await other.admin.get(up.location);
  assert.strictEqual(peek.status, 302, 'another church cannot open it');
  assert.strictEqual(peek.location, '/members/import');

  for (const [name, content, message] of [
    ['notes.pdf', 'x', /Upload a \.csv, \.xlsx or \.xls file/],
    ['only-header.csv', 'First name,Last name\n', /header row and at least one member/],
    ['huge.csv', Buffer.alloc(imp.MAX_FILE_BYTES + 10, 'a'), /larger than 5 MB/],
  ]) {
    const r = await admin.upload(name, content);
    assert.strictEqual(r.status, 302, name);
    assert.strictEqual(r.location, '/members/import', name);
    assert.match((await admin.get('/members/import')).text, message, name);
  }
  const tpl = await admin.get('/members/import/template.csv');
  assert.strictEqual(tpl.status, 200);
  assert.match(tpl.text, /First name,Last name/);
});
