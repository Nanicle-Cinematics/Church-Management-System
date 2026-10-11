'use strict';
// Regression tests for the code-review fixes: concurrent reversal / approval,
// cross-tenant photo writes, tithe validation, pledge payments, login hardening
// and reserved platform-operator addresses.
//
// Needs a dedicated, non-production DATABASE_URL, like the rest of the suite.
const os = require('os');
const fs = require('fs');
const path = require('path');

// routes-pg-html/members.js reads PHOTO_DIR at require time.
const PHOTO_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'church-photos-'));
process.env.PHOTO_DIR = PHOTO_DIR;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';

const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { createTenantApp } = require('../lib/tenant-http');
const { db, tenantDb } = require('../lib/tenant');
const { signupChurch } = require('../lib/provision');
const { authenticate } = require('../lib/auth');
const ledger = require('../lib/ledger-pg');

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
    await db.paymentVoucher.deleteMany({ where });
    await db.pledgePayment.deleteMany({ where });
    await db.pledge.deleteMany({ where });
    await db.harvest.deleteMany({ where });
    await db.tithe.deleteMany({ where });
    await db.journalLine.deleteMany({ where });
    await db.journalEntry.deleteMany({ where });
    await db.financialPeriod.deleteMany({ where });
    await db.expense.deleteMany({ where });
    await db.fund.deleteMany({ where });
    await db.activityLog.deleteMany({ where });
    await db.broadcastRecipient.deleteMany({ where });
    await db.broadcast.deleteMany({ where });
    await db.attendance.deleteMany({ where });
    await db.event.deleteMany({ where });
    await db.emailLog.deleteMany({ where });
    await db.securityAuditLog.deleteMany({ where });
    await db.member.deleteMany({ where });
    await db.account.deleteMany({ where });
    await db.user.deleteMany({ where });
    await db.specialCategory.deleteMany({ where });
    await db.serviceType.deleteMany({ where });
    await db.expenseCategory.deleteMany({ where });
    await db.church.deleteMany({ where: { id: { in: createdChurchIds } } });
  }
  fs.rmSync(PHOTO_DIR, { recursive: true, force: true });
  await db.$disconnect();
  await pool.end();
});

function uniqueEmail(tag) {
  return `${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
}

async function newChurch(tag) {
  const email = uniqueEmail(tag);
  const { church, user } = await signupChurch({ churchName: `${tag} Church`, name: 'Owner', email, password: 'password123' });
  createdChurchIds.push(church.id);
  return { churchId: church.id, user, email };
}

function client() {
  let cookie;
  const remember = (res) => {
    for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) if (c.startsWith('connect.sid=')) cookie = c.split(';')[0];
  };
  const headers = (extra) => ({ ...(cookie ? { cookie } : {}), ...extra });
  return {
    async postJson(p, body) {
      const res = await fetch(base + p, { method: 'POST', headers: headers({ 'content-type': 'application/json' }), body: JSON.stringify(body) });
      remember(res);
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    async getHtml(p) {
      const res = await fetch(base + p, { headers: headers(), redirect: 'manual' });
      remember(res);
      return { status: res.status, text: res.status < 300 ? await res.text() : '' };
    },
    async del(p) {
      const res = await fetch(base + p, { method: 'DELETE', headers: headers() });
      remember(res);
      return { status: res.status };
    },
    async postMultipart(p, form) {
      const res = await fetch(base + p, { method: 'POST', headers: headers(), body: form, redirect: 'manual' });
      remember(res);
      return { status: res.status, location: res.headers.get('location') };
    },
    async postUrlencoded(p, form) {
      const res = await fetch(base + p, { method: 'POST', headers: headers({ 'content-type': 'application/x-www-form-urlencoded' }), body: new URLSearchParams(form).toString() });
      remember(res);
      return { status: res.status };
    },
  };
}

async function signedInClient(tag) {
  const c = client();
  const signup = await c.postJson('/signup', { churchName: `${tag} Church`, name: 'Admin Person', email: uniqueEmail(tag), password: 'password123' });
  assert.strictEqual(signup.status, 201);
  createdChurchIds.push(signup.body.church.id);
  return { c, churchId: signup.body.church.id };
}

async function csrfFrom(c, p) {
  const page = await c.getHtml(p);
  return page.text.match(/name="_csrf" value="([^"]*)"/)[1];
}

// ---- Ledger: reversal and approval are claimed atomically -----------------

test('two concurrent reversals of one entry: exactly one succeeds, cash nets to zero', async () => {
  const { churchId } = await newChurch('rev-race');
  const scoped = tenantDb(churchId);
  const entryId = await ledger.postCashIncome(scoped, churchId, { date: '2026-06-01', amount: 100, category: 'Tithe', sourceType: 'GENERIC_INCOME', sourceId: 1 });

  const results = await Promise.allSettled([
    ledger.reverseJournal(scoped, churchId, entryId, 'a', null),
    ledger.reverseJournal(scoped, churchId, entryId, 'b', null),
  ]);
  assert.strictEqual(results.filter((r) => r.status === 'fulfilled').length, 1);
  const rejected = results.find((r) => r.status === 'rejected');
  assert.match(rejected.reason.message, /already reversed/);
  assert.ok(rejected.reason instanceof ledger.LedgerError);

  assert.strictEqual(await db.journalEntry.count({ where: { churchId } }), 2, 'original + exactly one reversal');
  assert.strictEqual(await ledger.assetBalance(scoped, churchId, ledger.ACC.CASH), 0);
});

test('two concurrent approvals of one expense post exactly one payment', async () => {
  const { churchId, user } = await newChurch('approve-race');
  const scoped = tenantDb(churchId);
  const fund = await scoped.fund.create({ data: { name: 'General', fundType: 'GENERAL', code: 'GEN' } });
  const expense = await scoped.expense.create({
    data: {
      category: 'Utilities', amount: 200, spentOn: new Date('2026-06-02'), fundId: fund.id,
      approvalStatus: 'SUBMITTED', submittedAt: new Date(), recordedBy: user.id,
    },
  });

  const results = await Promise.all([
    ledger.approveAndPayExpense(scoped, churchId, expense, user.id),
    ledger.approveAndPayExpense(scoped, churchId, expense, user.id),
  ]);
  assert.strictEqual(results.filter(Boolean).length, 1, 'only one approval may win');

  const entries = await db.journalEntry.findMany({ where: { churchId, sourceType: 'EXPENSE', sourceId: String(expense.id) } });
  assert.strictEqual(entries.length, 1, 'the expense must be paid once in the ledger');
  const paid = await scoped.expense.findUnique({ where: { id: expense.id } });
  assert.strictEqual(paid.approvalStatus, 'PAID');
  assert.strictEqual(paid.journalEntryId, entries[0].id);
});

test('approving into a locked period rolls the claim back (expense stays SUBMITTED)', async () => {
  const { churchId, user } = await newChurch('approve-locked');
  const scoped = tenantDb(churchId);
  const fund = await scoped.fund.create({ data: { name: 'General', fundType: 'GENERAL', code: 'GEN' } });
  await db.financialPeriod.create({ data: { churchId, year: 2026, month: 3, status: 'LOCKED' } });
  const expense = await scoped.expense.create({
    data: { category: 'Utilities', amount: 50, spentOn: new Date('2026-03-10'), fundId: fund.id, approvalStatus: 'SUBMITTED', submittedAt: new Date(), recordedBy: user.id },
  });
  await assert.rejects(() => ledger.approveAndPayExpense(scoped, churchId, expense, user.id), /locked/);
  assert.strictEqual((await scoped.expense.findUnique({ where: { id: expense.id } })).approvalStatus, 'SUBMITTED');
});

test('seeded expense categories land on the account they are named for', () => {
  assert.strictEqual(ledger.expenseAccountFor('Salaries'), ledger.ACC.MINISTERIAL);
  assert.strictEqual(ledger.expenseAccountFor('Office Supplies'), ledger.ACC.PRINTING);
  assert.strictEqual(ledger.expenseAccountFor('Outreach'), ledger.ACC.MISSION);
  assert.strictEqual(ledger.expenseAccountFor('Something else'), ledger.ACC.OTHER_EXPENSE);
});

// ---- HTTP: photos, tithes, API content type -------------------------------

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHrK7wAAAAABJRU5ErkJggg==', 'base64');

test('member photo: another church cannot overwrite or delete this church\'s photo file', async () => {
  const { c: a } = await signedInClient('photo-a');
  const { churchId: churchB } = await newChurch('photo-b');
  const victim = await db.member.create({ data: { churchId: churchB, externalId: 'MBR-V1', firstName: 'Victim', lastName: 'Member', membershipStatus: 'MEMBER', photoFilename: null } });
  const victimFile = path.join(PHOTO_DIR, `${victim.id}.png`);
  fs.writeFileSync(victimFile, PNG);

  const csrf = await csrfFrom(a, '/members');
  const form = new FormData();
  form.append('_csrf', csrf);
  form.append('photo', new Blob([PNG], { type: 'image/jpeg' }), 'x.jpg');
  const res = await a.postMultipart(`/members/${victim.id}/photo`, form);

  assert.strictEqual(res.status, 404);
  assert.ok(fs.existsSync(victimFile), 'church B\'s existing photo must not be deleted');
  assert.ok(!fs.existsSync(path.join(PHOTO_DIR, `${victim.id}.jpg`)), 'no file may be written for a member of another church');
});

test('member photo upload requires a CSRF token', async () => {
  const { c, churchId } = await signedInClient('photo-csrf');
  const m = await db.member.create({ data: { churchId, externalId: 'MBR-P1', firstName: 'Pic', lastName: 'Ture', membershipStatus: 'MEMBER' } });
  const form = new FormData();
  form.append('photo', new Blob([PNG], { type: 'image/png' }), 'x.png');
  const res = await c.postMultipart(`/members/${m.id}/photo`, form);
  assert.strictEqual(res.status, 403);
  assert.ok(!fs.existsSync(path.join(PHOTO_DIR, `${m.id}.png`)));
});

test('API refuses form-encoded bodies (cross-site forms cannot reach /api)', async () => {
  const { c } = await signedInClient('api-form');
  const res = await c.postUrlencoded('/api/users', { username: 'x', email: 'x@example.test', password: 'password123' });
  assert.strictEqual(res.status, 415);
});

test('tithe: a negative or non-numeric amount is rejected and leaves no row behind', async () => {
  const { c, churchId } = await signedInClient('tithe-neg');
  await db.fund.create({ data: { churchId, name: 'General', fundType: 'GENERAL', code: 'GEN' } });
  const member = await db.member.create({ data: { churchId, externalId: 'MBR-T1', firstName: 'Tithe', lastName: 'Payer', membershipStatus: 'MEMBER' } });
  for (const amount of [-500, 'abc', 0]) {
    const res = await c.postJson('/api/finance/tithes', { memberId: member.id, amount, titheDate: '2026-06-07' });
    assert.ok([400].includes(res.status), `amount ${amount} -> ${res.status}`);
  }
  assert.strictEqual(await db.tithe.count({ where: { churchId } }), 0);
  const ok = await c.postJson('/api/finance/tithes', { memberId: member.id, amount: 25, titheDate: '2026-06-07' });
  assert.strictEqual(ok.status, 201);
  assert.ok(ok.body.journalEntryId);
});

test('pledge payments recorded at the same time are both counted', async () => {
  const { c, churchId } = await signedInClient('pledge-race');
  await db.fund.create({ data: { churchId, name: 'General', fundType: 'GENERAL', code: 'GEN' } });
  const member = await db.member.create({ data: { churchId, externalId: 'MBR-PL', firstName: 'Pledge', lastName: 'Maker', membershipStatus: 'MEMBER' } });
  const harvest = await db.harvest.create({ data: { churchId, harvestType: 'END_OF_YEAR', harvestYear: 2026, harvestName: 'Harvest 2026' } });
  const pledge = await db.pledge.create({ data: { churchId, memberId: member.id, harvestId: harvest.id, pledgedAmount: 1000, pledgeDate: new Date('2026-01-01') } });

  const results = await Promise.all([10, 20, 30, 40].map((add) => c.postJson(`/api/finance/pledges/${pledge.id}/pay`, { add })));
  assert.ok(results.every((r) => r.status === 201), JSON.stringify(results.map((r) => r.status)));
  const after = await db.pledge.findUnique({ where: { id: pledge.id } });
  assert.strictEqual(Number(after.paidAmount), 100, 'no payment may be lost to a read-modify-write race');
});

// ---- Auth ------------------------------------------------------------------

test('login: a missing / non-string password is a plain failure, not a crash', async () => {
  const { email, user } = await newChurch('login-types');
  for (const password of [undefined, null, 12345678, ['password123'], {}]) {
    // Each failure counts toward the 5-attempt lockout, so reset between tries.
    await db.user.update({ where: { id: user.id }, data: { failedAttempts: 0, lockedUntil: null } });
    const r = await authenticate(email, password);
    assert.strictEqual(r.status, 'invalid');
  }
});

test('login: parallel wrong guesses still reach the lockout', async () => {
  const { email } = await newChurch('login-parallel');
  await Promise.all(Array.from({ length: 6 }, () => authenticate(email, 'wrong-password')));
  const r = await authenticate(email, 'password123');
  assert.strictEqual(r.status, 'locked');
});

// ---- Platform operator addresses -------------------------------------------

test('a platform-operator email cannot be registered once any church exists', async () => {
  await newChurch('some-existing-church');
  const reserved = uniqueEmail('operator');
  const previous = process.env.PLATFORM_ADMIN_EMAILS;
  process.env.PLATFORM_ADMIN_EMAILS = reserved;
  try {
    await assert.rejects(
      () => signupChurch({ churchName: 'Squatter', name: 'Squatter', email: reserved, password: 'password123' }),
      /reserved/,
    );
  } finally {
    if (previous === undefined) delete process.env.PLATFORM_ADMIN_EMAILS; else process.env.PLATFORM_ADMIN_EMAILS = previous;
  }
});

test('deleting a user frees their email for re-invitation', async () => {
  const { c } = await signedInClient('user-reinvite');
  const email = uniqueEmail('teammate');
  const created = await c.postJson('/api/users', { username: 'mate', email, password: 'password123', role: 'EDITOR' });
  assert.strictEqual(created.status, 201);
  assert.strictEqual((await c.del(`/api/users/${created.body.id}`)).status, 204);
  const again = await c.postJson('/api/users', { username: 'mate2', email, password: 'password123', role: 'EDITOR' });
  assert.strictEqual(again.status, 201, 'the freed email can be used again');
});

// ---- Second round: approval claim, sender identity, send caps, members, unsubscribe ----

test('approval claim fails when the expense was edited after the approver read it', async () => {
  const { churchId, user } = await newChurch('approve-stale');
  const scoped = tenantDb(churchId);
  const fund = await scoped.fund.create({ data: { name: 'General', fundType: 'GENERAL', code: 'GEN' } });
  const expense = await scoped.expense.create({
    data: { category: 'Utilities', amount: 100, spentOn: new Date('2026-06-02'), fundId: fund.id, approvalStatus: 'SUBMITTED', submittedAt: new Date(), recordedBy: user.id },
  });
  const seenByApprover = await scoped.expense.findUnique({ where: { id: expense.id } });
  await scoped.expense.update({ where: { id: expense.id }, data: { amount: 4000 } }); // edit lands in between

  assert.strictEqual(await ledger.approveAndPayExpense(scoped, churchId, seenByApprover, user.id), null);
  assert.strictEqual(await db.journalEntry.count({ where: { churchId } }), 0, 'nothing may be posted for an amount nobody approved');
  assert.strictEqual((await scoped.expense.findUnique({ where: { id: expense.id } })).approvalStatus, 'SUBMITTED');
});

test('email sender: church settings cannot choose the From address or inject headers', () => {
  const { emailDeliveryInfo } = require('../lib/delivery');
  const info = emailDeliveryInfo({
    provider: 'SMTP', senderName: 'Grace <ceo@bank.example>\r\nBcc: victim@example.test', senderEmail: 'ceo@bank.example', replyToEmail: '',
  }, 'Grace Chapel');
  assert.ok(!/ceo@bank\.example/.test(info.senderHeader), `From must not carry the church-chosen address: ${info.senderHeader}`);
  assert.ok(!/[\r\n]/.test(info.senderHeader), 'no header injection');
  assert.strictEqual(info.replyToEmail, 'ceo@bank.example', 'replies still reach the church');
});

test('broadcast: a message over the length limit is refused', async () => {
  const { c } = await signedInClient('bc-length');
  const res = await c.postJson('/api/communications/broadcasts', { channel: 'sms', body: 'x'.repeat(901), allMembers: true });
  assert.strictEqual(res.status, 400);
});

test('broadcast: the daily sending cap stops an oversized audience', async () => {
  const { c, churchId } = await signedInClient('bc-cap');
  for (let i = 0; i < 3; i++) {
    await db.member.create({ data: { churchId, externalId: `MBR-C${i}`, firstName: 'Cap', lastName: `M${i}`, membershipStatus: 'MEMBER', mobilePhone: `02400000${i}0`, preferredChannel: 'EITHER' } });
  }
  const previous = process.env.BROADCAST_DAILY_LIMIT_FREE;
  process.env.BROADCAST_DAILY_LIMIT_FREE = '2';
  try {
    const res = await c.postJson('/api/communications/broadcasts', { channel: 'sms', body: 'hello', allMembers: true });
    assert.strictEqual(res.status, 429);
    assert.strictEqual(res.body.code, 'send_limit');
    assert.strictEqual(await db.broadcast.count({ where: { churchId } }), 0, 'a refused broadcast must create nothing');
  } finally {
    if (previous === undefined) delete process.env.BROADCAST_DAILY_LIMIT_FREE; else process.env.BROADCAST_DAILY_LIMIT_FREE = previous;
  }
});

test('members API: no unsubscribeToken, bad enums are 400, concurrent creates get distinct ids', async () => {
  const { c } = await signedInClient('member-api');
  const bad = await c.postJson('/api/members', { firstName: 'A', lastName: 'B', gender: 'Robot' });
  assert.strictEqual(bad.status, 400);
  const badDate = await c.postJson('/api/members', { firstName: 'A', lastName: 'B', dateOfBirth: 'not-a-date' });
  assert.strictEqual(badDate.status, 400);

  const results = await Promise.all(Array.from({ length: 4 }, (_, i) => c.postJson('/api/members', { firstName: `P${i}`, lastName: 'Parallel', gender: 'M' })));
  assert.ok(results.every((r) => r.status === 201), JSON.stringify(results.map((r) => r.status)));
  assert.strictEqual(new Set(results.map((r) => r.body.externalId)).size, 4, 'ids must be unique');
  assert.ok(results.every((r) => !('unsubscribeToken' in r.body)), 'the token is a credential');
});

test('unsubscribe: GET only confirms, POST opts the member out, bad tokens 404', async () => {
  const { churchId } = await newChurch('unsub');
  const token = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  const member = await db.member.create({ data: { churchId, externalId: 'MBR-U1', firstName: 'Una', lastName: 'Subscribed', membershipStatus: 'MEMBER', preferredChannel: 'EITHER', unsubscribeToken: token } });

  const page = await fetch(`${base}/u/${token}`);
  const html = await page.text();
  assert.strictEqual(page.status, 200);
  assert.doesNotMatch(html, /Una|Subscribed/, 'the page must not reveal who the member is');
  assert.strictEqual((await db.member.findUnique({ where: { id: member.id } })).preferredChannel, 'EITHER', 'GET must not change anything');

  const cookie = (page.headers.getSetCookie() || []).map((x) => x.split(';')[0]).join('; ');
  const csrf = html.match(/name="_csrf" value="([^"]*)"/)[1];
  const post = await fetch(`${base}/u/${token}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie }, body: new URLSearchParams({ _csrf: csrf }).toString() });
  assert.strictEqual(post.status, 200);
  assert.strictEqual((await db.member.findUnique({ where: { id: member.id } })).preferredChannel, 'NONE');

  assert.strictEqual((await fetch(`${base}/u/${'0'.repeat(32)}`)).status, 404);
  assert.strictEqual((await fetch(`${base}/u/not-a-token`)).status, 404);
});

test('oversized text fields are refused up front', async () => {
  const { c } = await signedInClient('too-long');
  const res = await c.postJson('/api/members', { firstName: 'A', lastName: 'B', notes: 'x'.repeat(25000) });
  assert.strictEqual(res.status, 413);
});

test('missing-members report ignores future services', async () => {
  const { c, churchId } = await signedInClient('missing-report');
  await db.church.update({ where: { id: churchId }, data: { plan: 'pro' } });
  const m = await db.member.create({ data: { churchId, externalId: 'MBR-R1', firstName: 'Reg', lastName: 'Ular', membershipStatus: 'MEMBER' } });
  const past = await db.event.create({ data: { churchId, title: 'Last Sunday', eventType: 'SERVICE', startsAt: new Date(Date.now() - 3 * 86400000), checkinToken: 'p'.repeat(32) } });
  await db.attendance.create({ data: { churchId, eventId: past.id, memberId: m.id } });
  await db.event.create({ data: { churchId, title: 'Next Sunday', eventType: 'SERVICE', startsAt: new Date(Date.now() + 4 * 86400000), checkinToken: 'f'.repeat(32) } });

  const viaClient = await c.getHtml('/reports/members');
  assert.ok([200, 402].includes(viaClient.status));
  if (viaClient.status === 200) assert.doesNotMatch(viaClient.text, /Reg Ular/, 'attended the only past service, and the future one must not count');
});
