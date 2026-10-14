'use strict';
// Monthly allowances (Finance > Allowances, lib/allowances.js): the worker
// list, the monthly run that drafts expenses for approval, the alerts and
// reminders, and device-notification subscriptions (lib/push.js).
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { Prisma } = require('@prisma/client');
const { createTenantApp } = require('../lib/tenant-http');
const { db } = require('../lib/tenant');
const { signupChurch } = require('../lib/provision');
const allowances = require('../lib/allowances');

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
  return {
    async get(p) {
      const res = await fetch(base + p, { headers: cookie ? { cookie } : {}, redirect: 'manual' });
      remember(res);
      return { status: res.status, headers: res.headers, text: await res.text() };
    },
    async json(p, body) {
      const res = await fetch(base + p, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
      remember(res);
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    },
    async form(p, fields, from = '/finance/allowances') {
      const page = await this.get(from);
      const csrf = (page.text.match(/name="_csrf" value="([^"]*)"/) || [])[1];
      const res = await fetch(base + p, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) }, body: new URLSearchParams({ ...fields, _csrf: csrf || '' }).toString() });
      remember(res);
      await res.text(); // the session (and flash) is saved before the response ends
      return { status: res.status, location: res.headers.get('location') };
    },
  };
}

async function signIn(email) {
  const c = client();
  assert.strictEqual((await c.json('/login', { email, password: 'password123' })).status, 200);
  return c;
}

async function newChurch(tag) {
  const email = unique(tag);
  const { church } = await signupChurch({ churchName: `${tag} Church`, name: 'Owner', email, password: 'password123' });
  churchIds.push(church.id);
  await db.church.update({ where: { id: church.id }, data: { plan: 'pro' } });
  const fund = await db.fund.create({ data: { churchId: church.id, name: 'General Fund' } });
  return { churchId: church.id, fund, owner: await signIn(email) };
}

async function staff(churchId, role, financeRole, extra = {}) {
  const email = unique(`${role}-${financeRole}`.toLowerCase());
  const user = await db.user.create({ data: { churchId, username: `${role}-${financeRole}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, email, passwordHash: await bcrypt.hash('password123', 4), role, financeRole, ...extra } });
  return { user, client: await signIn(email) };
}

test.before(async () => {
  const app = createTenantApp({ pool });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  server.close();
  // Every church-owned table, retried until foreign keys stop getting in the way.
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

test('due dates: the due day, or the last day of a shorter month, with a few catch-up days', () => {
  assert.strictEqual(allowances.dueDateFor('2027-02', 30).toISOString().slice(0, 10), '2027-02-28');
  assert.strictEqual(allowances.dueDateFor('2028-02', 31).toISOString().slice(0, 10), '2028-02-29');
  assert.strictEqual(allowances.dueDateFor('2026-10', 25).toISOString().slice(0, 10), '2026-10-25');
  assert.strictEqual(allowances.isDue(new Date('2026-10-24T23:00:00Z'), 25), false);
  assert.strictEqual(allowances.isDue(new Date('2026-10-25T00:30:00Z'), 25), true);
  assert.strictEqual(allowances.isDue(new Date('2026-10-28T12:00:00Z'), 25), true, 'caught up after downtime');
  assert.strictEqual(allowances.isDue(new Date('2026-10-29T12:00:00Z'), 25), false);
  assert.strictEqual(allowances.isDue(new Date('2026-10-25T12:00:00Z'), null), false, 'off');
  assert.strictEqual(allowances.periodLabel('2026-10'), 'October 2026');
});

test('text alerts go to approvers\' sign-in phones and the extra numbers, once each', () => {
  const numbers = allowances.smsNumbers([{ phone: '+233244127781' }, { phone: null }, { phone: 'deleted+4+x' }], '024 412 7781, 0205551234; bad');
  assert.deepStrictEqual(numbers.sort(), ['+233205551234', '+233244127781']);
});

test('a fund manager keeps the worker list and the due day; others with finance access only read it', async () => {
  const { churchId, fund, owner } = await newChurch('allow-list');
  const member = await db.member.create({ data: { churchId, firstName: 'Kwame', lastName: 'Caretaker' } });

  assert.strictEqual((await owner.form('/finance/allowances', { memberId: String(member.id), role: 'Caretaker', amount: '450', fundId: String(fund.id) })).status, 302);
  assert.strictEqual((await owner.form('/finance/allowances', { payeeName: 'Ama Organist', amount: '300.50' })).status, 302);
  assert.strictEqual((await owner.form('/finance/allowances', { payeeName: 'Nobody', amount: '0' })).status, 302);
  assert.strictEqual(await db.allowance.count({ where: { churchId } }), 2, 'a zero amount is refused');
  assert.strictEqual((await owner.form('/finance/allowances/settings', { dueDay: '25', alertPhones: '024 412 7781' })).status, 302);
  const settings = await db.financeSetting.findUnique({ where: { churchId } });
  assert.strictEqual(settings.allowanceDueDay, 25);
  assert.strictEqual(settings.allowanceAlertPhones, '+233244127781');
  assert.strictEqual((await owner.form('/finance/allowances/settings', { dueDay: '5', alertPhones: 'not a number' })).status, 302);
  assert.strictEqual((await db.financeSetting.findUnique({ where: { churchId } })).allowanceDueDay, 25, 'a bad number saves nothing');

  const page = await owner.get('/finance/allowances');
  assert.strictEqual(page.status, 200);
  assert.match(page.text, /Kwame Caretaker/);
  assert.match(page.text, /Ama Organist/);
  assert.match(page.text, /GH₵ 750\.50/, 'monthly total');
  assert.match(page.text, /Send me a test alert/);
  assert.match((await owner.get('/finance')).text, /href="\/finance\/allowances"/, 'linked from the Finance hub');

  const cashier = await staff(churchId, 'EDITOR', 'CASHIER');
  assert.strictEqual((await cashier.client.get('/finance/allowances')).status, 200);
  assert.doesNotMatch((await cashier.client.get('/finance/allowances')).text, /Add a worker/);
  assert.strictEqual((await cashier.client.form('/finance/allowances', { payeeName: 'Sneaky', amount: '1' })).status, 403);
  const viewer = await staff(churchId, 'VIEWER', 'NONE');
  assert.strictEqual((await viewer.client.get('/finance/allowances')).status, 403);

  const ama = await db.allowance.findFirst({ where: { churchId, payeeName: 'Ama Organist' } });
  assert.strictEqual((await owner.form(`/finance/allowances/${ama.id}`, { payeeName: 'Ama Organist', role: 'Organist', amount: '320' }, `/finance/allowances/${ama.id}/edit`)).status, 302);
  assert.strictEqual(Number((await db.allowance.findUnique({ where: { id: ama.id } })).amount), 320);
});

test('the monthly run drafts one expense per active worker, once, for any fund manager to approve', async () => {
  const { churchId, fund, owner } = await newChurch('allow-run');
  await db.allowance.createMany({ data: [
    { churchId, payeeName: 'Kofi Sexton', role: 'Sexton', amount: 400, fundId: fund.id },
    { churchId, payeeName: 'Esi Cleaner', amount: 250 },
    { churchId, payeeName: 'Paused Person', amount: 999, active: false },
  ] });

  const [a, b] = await Promise.all([allowances.createRun(churchId, '2026-10'), allowances.createRun(churchId, '2026-10')]);
  assert.ok(Boolean(a) !== Boolean(b), 'two machines at once still draft the month once');
  const run = a || b;
  assert.strictEqual(run.workerCount, 2);
  assert.strictEqual(Number(run.total), 650);
  assert.strictEqual(await allowances.createRun(churchId, '2026-10'), null, 'already drafted');

  const expenses = await db.expense.findMany({ where: { churchId, allowanceRunId: run.id }, orderBy: { paidTo: 'asc' } });
  assert.deepStrictEqual(expenses.map((e) => [e.paidTo, Number(e.amount), e.approvalStatus]), [['Esi Cleaner', 250, 'SUBMITTED'], ['Kofi Sexton', 400, 'SUBMITTED']]);
  assert.match(expenses[1].description, /Allowance – October 2026 \(Sexton\)/);
  assert.strictEqual(expenses[0].fundId, fund.id, 'no fund chosen: the default fund');
  assert.ok(expenses.every((e) => e.recordedBy === null));

  const dash = await owner.get('/');
  assert.match(dash.text, /2 allowances due for approval/);

  // The owner recorded nothing, so they may approve.
  const approve = await owner.form(`/finance/expenses/${expenses[0].id}/approve`, {}, '/finance/expenses');
  assert.strictEqual(approve.status, 302);
  assert.strictEqual((await db.expense.findUnique({ where: { id: expenses[0].id } })).approvalStatus, 'PAID');
});

test('the scheduler drafts churches that are due, and reminds once about anything unpaid after five days', async () => {
  const { churchId } = await newChurch('allow-sched');
  await db.allowance.create({ data: { churchId, payeeName: 'Yaw Driver', amount: 500 } });
  await db.financeSetting.upsert({ where: { churchId }, create: { churchId, allowanceDueDay: 10 }, update: { allowanceDueDay: 10 } });
  await staff(churchId, 'VIEWER', 'TREASURER', { phone: `+23324${String(Date.now()).slice(-7)}` });

  assert.ok(!(await allowances.runDueAllowances(new Date('2031-03-09T12:00:00Z'))).includes(churchId), 'not due yet');
  assert.ok((await allowances.runDueAllowances(new Date('2031-03-10T06:00:00Z'))).includes(churchId));
  assert.ok(!(await allowances.runDueAllowances(new Date('2031-03-10T07:00:00Z'))).includes(churchId), 'the next hour does nothing');
  const run = await db.allowanceRun.findFirst({ where: { churchId, period: '2031-03' } });
  assert.ok(run);
  assert.ok(await db.activityLog.findFirst({ where: { churchId, kind: 'allowance_run' } }), 'logged for the audit trail');
  // Approvers were emailed (a dry run under the test runner, but logged).
  assert.ok(await db.emailLog.count({ where: { churchId, subject: 'March 2031 allowances are due' } }) >= 1);

  assert.deepStrictEqual(await allowances.sendAllowanceReminders(new Date(run.createdAt.getTime() + 4 * 86400000)), []);
  const later = new Date(run.createdAt.getTime() + 6 * 86400000);
  assert.ok((await allowances.sendAllowanceReminders(later)).includes(run.id));
  assert.ok(!(await allowances.sendAllowanceReminders(later)).includes(run.id), 'only once');
  assert.ok(await db.emailLog.count({ where: { churchId, subject: 'Reminder: March 2031 allowances not yet paid' } }) >= 1);
});

test('a suspended church is skipped; nothing is drafted with no active worker', async () => {
  const { churchId } = await newChurch('allow-skip');
  await db.financeSetting.upsert({ where: { churchId }, create: { churchId, allowanceDueDay: 12 }, update: { allowanceDueDay: 12 } });
  assert.ok(!(await allowances.runDueAllowances(new Date('2031-04-12T06:00:00Z'))).includes(churchId), 'no workers');
  await db.allowance.create({ data: { churchId, payeeName: 'Abena Usher', amount: 100 } });
  await db.church.update({ where: { id: churchId }, data: { suspendedAt: new Date() } });
  assert.ok(!(await allowances.runDueAllowances(new Date('2031-04-12T06:00:00Z'))).includes(churchId), 'suspended');
});

test('"Draft now" and the test alert work from the page', async () => {
  const { churchId, owner } = await newChurch('allow-now');
  await db.allowance.create({ data: { churchId, payeeName: 'Efua Secretary', amount: 600 } });
  assert.strictEqual((await owner.form('/finance/allowances/run', {})).status, 302);
  const page = await owner.get('/finance/allowances');
  assert.match(page.text, /1 of 1<\/b> waiting for approval/);
  assert.strictEqual((await owner.form('/finance/allowances/run', {})).status, 302);
  assert.strictEqual(await db.allowanceRun.count({ where: { churchId } }), 1);

  assert.strictEqual((await owner.form('/finance/allowances/test-alert', {})).status, 302);
  assert.match((await owner.get('/finance/allowances')).text, /Test alert: email/);
});

test('device notifications: a signed-in browser subscribes and unsubscribes; the service worker and manifest are served', async () => {
  const { churchId, owner } = await newChurch('allow-push');
  const sub = { endpoint: `https://push.example.test/${Date.now()}`, keys: { p256dh: 'BPk3x', auth: 'aGVsbG8' } };
  assert.strictEqual((await client().json('/api/push/subscribe', sub)).status, 401);
  assert.strictEqual((await owner.json('/api/push/subscribe', { endpoint: 'http://insecure.test/x', keys: sub.keys })).status, 400);
  assert.strictEqual((await owner.json('/api/push/subscribe', sub)).status, 201);
  assert.strictEqual((await owner.json('/api/push/subscribe', sub)).status, 201, 'subscribing again is fine');
  assert.strictEqual(await db.pushSubscription.count({ where: { churchId, endpoint: sub.endpoint } }), 1);
  assert.strictEqual((await owner.json('/api/push/unsubscribe', { endpoint: sub.endpoint })).status, 200);
  assert.strictEqual(await db.pushSubscription.count({ where: { endpoint: sub.endpoint } }), 0);

  const sw = await client().get('/sw.js');
  assert.strictEqual(sw.status, 200);
  assert.strictEqual(sw.headers.get('service-worker-allowed'), '/');
  assert.match(sw.text, /showNotification/);
  const manifest = await client().get('/manifest.webmanifest');
  assert.strictEqual(manifest.status, 200);
  assert.strictEqual(JSON.parse(manifest.text).display, 'standalone');
  assert.match((await owner.get('/')).text, /rel="manifest"/);
});
