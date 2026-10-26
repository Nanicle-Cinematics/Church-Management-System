'use strict';
// The dashboard's "Recent activity" reads like the life of the church: housekeeping entries (settings,
// the colour of the app, the preacher list ...) are left out, however recent, and money entries are for
// the roles that may see money.
const test = require('node:test');
const assert = require('node:assert');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const { createTenantApp } = require('../lib/tenant-http');
const { db } = require('../lib/tenant');
const { signupChurch } = require('../lib/provision');
const { fmtDMY, fmtLongDate } = require('../lib/format');
const { entryCard } = require('../lib/almanac-ui');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const PASSWORD = 'Tr0ubadour-7!';
const churchIds = [];
let server, base;

function client() {
  let cookie;
  const remember = (res) => { for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) if (c.startsWith('connect.sid=')) cookie = c.split(';')[0]; };
  const api = {
    async page(p) { const res = await fetch(base + p, { headers: cookie ? { cookie } : {}, redirect: 'manual' }); remember(res); return { status: res.status, text: await res.text() }; },
    async form(p, fields, from = p) {
      const csrf = ((await api.page(from)).text.match(/name="_csrf" value="([^"]*)"/) || [])[1] || '';
      const res = await fetch(base + p, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) }, body: new URLSearchParams({ ...fields, _csrf: csrf }).toString() });
      remember(res); return { status: res.status };
    },
  };
  return api;
}

test.before(async () => {
  const app = createTenantApp({ pool });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  server.close();
  const where = { churchId: { in: churchIds } };
  for (const m of ['preachingPlan', 'event', 'member', 'activityLog', 'securityAuditLog', 'account', 'user', 'specialCategory', 'serviceType', 'expenseCategory']) await db[m].deleteMany({ where }).catch(() => {});
  await db.church.deleteMany({ where: { id: { in: churchIds } } }).catch(() => {});
  await db.$disconnect();
  await pool.end();
});

test('Recent activity shows church life only, hides housekeeping however recent, and keeps money for finance roles', async () => {
  const email = `feed-${process.pid}-${Date.now()}@example.test`;
  const { church } = await signupChurch({ churchName: 'Feed Church', name: 'Owner', email, password: PASSWORD });
  churchIds.push(church.id);
  const at = (minsAgo) => new Date(Date.now() - minsAgo * 60000);
  const log = (kind, description, minsAgo) => db.activityLog.create({ data: { churchId: church.id, kind, description, occurredAt: at(minsAgo) } });

  // older, real entries ...
  await log('member_added', 'New member added: Ama Sample', 30);
  await log('event_created', 'Event scheduled: Harvest Thanksgiving', 29);
  await log('preaching_scheduled', 'Scheduled preaching for Sun, 01 Nov 2026', 28);
  await log('preaching_reminder', 'Sent preaching reminder to Mr. Boateng for Sun, 01 Nov 2026', 27);
  await log('expense_submitted', 'Expense submitted for approval: Utilities (GH₵ 120.00)', 26);
  // ... pushed well down by lots of newer housekeeping
  for (let i = 0; i < 12; i++) await log('settings_updated', `Welcome animation set to Circle reveal ${i}`, 10 - i * 0.5);
  await log('almanac_colour_set', 'Liturgical colour set to Green for the week', 4);
  await log('preaching_reminder_sent', 'Reminder sent to preacher', 3);
  await log('allowance_settings_updated', 'Allowances due on the 1st of each month', 2);
  await log('user_role_changed', 'Role changed for Kofi', 1);
  await log('sms_sender_requested', 'SMS sender name requested', 1);
  await log('preacher_added', 'Preacher added: S Rev. Ama', 1);

  const admin = client();
  await admin.form('/login', { email, password: PASSWORD }, '/login');
  const feed = (html) => { const a = html.indexOf('Recent activity'); return html.slice(a, a + 6000); };
  const t = feed((await admin.page('/')).text);
  for (const shown of ['Ama Sample', 'Harvest Thanksgiving', 'Scheduled preaching', 'Sent preaching reminder to Mr. Boateng', 'Utilities']) assert.ok(t.includes(shown), `shown: ${shown}`);
  for (const hidden of ['Welcome animation', 'Liturgical colour', 'Reminder sent to preacher', 'Allowances due', 'Role changed', 'SMS sender', 'Preacher added']) assert.ok(!t.includes(hidden), `hidden: ${hidden}`);

  // someone without finance access does not see the money entry, and still sees the rest
  await db.user.create({ data: { churchId: church.id, username: `viewer-${Date.now()}`, email: `v-${process.pid}-${Date.now()}@example.test`, passwordHash: bcrypt.hashSync(PASSWORD, 4), role: 'VIEWER', financeRole: 'NONE', emailVerifiedAt: new Date() } });
  const vEmail = (await db.user.findFirst({ where: { churchId: church.id, role: 'VIEWER' } })).email;
  const viewer = client();
  await viewer.form('/login', { email: vEmail, password: PASSWORD }, '/login');
  const v = feed((await viewer.page('/')).text);
  assert.ok(v.includes('Ama Sample') && v.includes('Harvest Thanksgiving'));
  assert.ok(!v.includes('Utilities'), 'money stays with the finance roles');
  assert.ok(!v.includes('Welcome animation'));
});

test('dates on the dashboard are dd/mm/yyyy', async () => {
  assert.strictEqual(fmtDMY(new Date(2026, 9, 6)), '06/10/2026');
  assert.strictEqual(fmtDMY(new Date('2026-12-25T00:00:00Z'), { utc: true }), '25/12/2026');
  assert.strictEqual(fmtDMY('not a date'), '');
  const e = { id: 1, serviceDate: new Date('2026-11-01T00:00:00Z'), serviceLabel: '', title: 'T', colour: 'GREEN', hymns: [] };
  assert.match(entryCard(e, { numericDate: true }), /class="when">01\/11\/2026</);
  assert.match(entryCard(e), /class="when">Sunday, 1 November 2026</, 'the Almanac page keeps its long form');

  const email = `dmy-${process.pid}-${Date.now()}@example.test`;
  const { church } = await signupChurch({ churchName: 'Dates Church', name: 'Owner', email, password: PASSWORD });
  churchIds.push(church.id);
  const admin = client();
  await admin.form('/login', { email, password: PASSWORD }, '/login');
  const html = (await admin.page('/')).text;
  assert.ok(html.includes(`<p class="eyebrow">${fmtDMY(new Date())}</p>`), "today's date at the top of the dashboard is dd/mm/yyyy");
  assert.match(html.match(/<p class="eyebrow">([^<]*)<\/p>/)[1], /^\d{2}\/\d{2}\/\d{4}$/, 'just the numbers, no month or weekday names');

  // the This Sunday card
  const today = new Date(Date.UTC(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()));
  const sunday = new Date(today.getTime() + ((7 - today.getUTCDay()) % 7) * 86400000);
  const entry = await db.almanacEntry.create({ data: { serviceDate: sunday, serviceLabel: '', title: `Date Sunday ${process.pid}`, colour: 'GREEN', hymns: ['1'] } }).catch(() => null);
  try {
    const card = (await admin.page('/')).text;
    const at = card.indexOf('id="this-sunday"');
    if (entry && at >= 0) {
      const section = card.slice(at, at + 2500);
      assert.ok(section.includes(fmtDMY(sunday, { utc: true })), 'the card shows the date as dd/mm/yyyy');
      assert.doesNotMatch(section, /\b20\d\d-\d\d-\d\d\b/, 'not as 2026-11-01');
    }
  } finally { if (entry) await db.almanacEntry.delete({ where: { id: entry.id } }).catch(() => {}); }
});

test('the smaller dates on the dashboard (events, older activity, birthdays) are dd/mm/yyyy too', async () => {
  const email = `dmy2-${process.pid}-${Date.now()}@example.test`;
  const { church } = await signupChurch({ churchName: 'Compact Dates Church', name: 'Owner', email, password: PASSWORD });
  churchIds.push(church.id);
  const inDays = (n) => { const d = new Date(); d.setHours(10, 30, 0, 0); d.setDate(d.getDate() + n); return d; };

  const ev = await db.event.create({ data: { churchId: church.id, title: 'Harvest Service', eventType: 'SERVICE', startsAt: inDays(3), location: 'Main hall' } });
  await db.activityLog.create({ data: { churchId: church.id, kind: 'member_added', description: 'New member added: Old Entry', occurredAt: inDays(-12) } });
  const bday = inDays(2);
  await db.member.create({ data: { churchId: church.id, firstName: 'Bola', lastName: 'Birthday', mobilePhone: '0240000000', membershipStatus: 'MEMBER', dateOfBirth: new Date(Date.UTC(1990, bday.getMonth(), bday.getDate())) } });

  const admin = client();
  await admin.form('/login', { email, password: PASSWORD }, '/login');
  const html = (await admin.page('/')).text;
  const body = html.slice(html.indexOf('class="pd"'));

  assert.ok(body.includes(`${fmtDMY(inDays(3))} · 10:30`), 'an upcoming event: dd/mm/yyyy · time, with the place after it');
  assert.ok(!/class="pd-date"><small>/.test(body), 'the month-name tile is gone');
  const feed = body.slice(body.indexOf('Recent activity'), body.indexOf('Recent activity') + 3000);
  assert.ok(feed.includes(fmtDMY(inDays(-12))), 'an activity entry older than a week shows dd/mm/yyyy');
  assert.ok(body.includes('Bola Birthday'), 'the birthday is listed');
  assert.ok(body.includes(fmtDMY(bday)), 'a birthday coming up shows dd/mm/yyyy');
  // none of the day-and-month-name forms are left ("27 Oct", "Mon 27 Oct")
  assert.ok(!/\b\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/.test(body.replace(/<style[\s\S]*?<\/style>/g, '')), 'no "27 Oct" style dates on the dashboard');
  await db.event.delete({ where: { id: ev.id } }).catch(() => {});
});

test('This Sunday without an Almanac entry: the date above the preacher is written out as 1 November, 2026', async () => {
  assert.strictEqual(fmtLongDate(new Date('2026-11-01T00:00:00Z'), { utc: true }), '1 November, 2026');
  assert.strictEqual(fmtLongDate(new Date('2026-12-25T00:00:00Z'), { utc: true }), '25 December, 2026');
  assert.strictEqual(fmtLongDate('not a date'), '');

  const email = `long-${process.pid}-${Date.now()}@example.test`;
  const { church } = await signupChurch({ churchName: 'Long Date Church', name: 'Owner', email, password: PASSWORD });
  churchIds.push(church.id);
  const now = new Date();
  const today = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const sunday = new Date(today.getTime() + ((7 - today.getUTCDay()) % 7) * 86400000);
  await db.preachingPlan.create({ data: { churchId: church.id, preachDate: sunday, preacherName: 'Mr. Boateng' } });

  const admin = client();
  await admin.form('/login', { email, password: PASSWORD }, '/login');
  const html = (await admin.page('/')).text;
  const card = html.slice(html.indexOf('id="this-sunday"'), html.indexOf('id="this-sunday"') + 2500);
  if (card.includes('almanac-entry')) return; // the shared Almanac has an entry for this Sunday: the card shows that instead
  assert.ok(card.includes(`<p><b>${fmtLongDate(sunday, { utc: true })}</b></p><p class="preaching"><b>Preaching:</b> Mr. Boateng`), 'the written-out date sits directly above the preaching line');
  assert.ok(card.includes(`<p class="sub">${fmtDMY(sunday, { utc: true })}</p>`), 'the small date under the heading stays dd/mm/yyyy');
});
