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
  for (const m of ['activityLog', 'securityAuditLog', 'account', 'user', 'specialCategory', 'serviceType', 'expenseCategory']) await db[m].deleteMany({ where }).catch(() => {});
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
