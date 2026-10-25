'use strict';
// Cash control: count sheets and bank deposits (routes-pg-html/cash-control.js).
//
// The properties that matter are refusals: a second officer must verify,
// a deposit cannot bank more than the books hold, money cannot be banked
// twice, banked money cannot be reversed behind its deposit's back, and
// another church's records cannot be read, verified or ticked.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { createTenantApp } = require('../lib/tenant-http');
const { db, tenantDb } = require('../lib/tenant');
const ledger = require('../lib/ledger-pg');

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
    await db.cashCountLine.deleteMany({ where });
    await db.cashCountSheet.deleteMany({ where });
    await db.bankDeposit.deleteMany({ where });
    await db.dayBornSplit.deleteMany({ where });
    await db.service.deleteMany({ where });
    await db.tithe.deleteMany({ where });
    await db.dayBornCollection.deleteMany({ where });
    await db.financeReceipt.deleteMany({ where });
    await db.incomeRecord.deleteMany({ where });
    await db.member.deleteMany({ where });
    await db.activityLog.deleteMany({ where });
    await db.journalLine.deleteMany({ where });
    await db.journalEntry.deleteMany({ where });
    await db.financialPeriod.deleteMany({ where });
    await db.paymentVoucher.deleteMany({ where });
    await db.expense.deleteMany({ where });
    await db.financeSetting.deleteMany({ where });
    await db.fund.deleteMany({ where });
    await db.account.deleteMany({ where });
    await db.expenseCategory.deleteMany({ where });
    await db.specialCategory.deleteMany({ where });
    await db.serviceType.deleteMany({ where });
    await db.user.deleteMany({ where });
    await db.church.deleteMany({ where: { id: { in: createdChurchIds } } });
  }
  await db.$disconnect();
  await pool.end();
});

function client() {
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
    async del(p) {
      const res = await fetch(base + p, { method: 'DELETE', headers: cookie ? { cookie } : {} });
      remember(res);
      return { status: res.status, body: res.status === 204 ? null : await res.json() };
    },
    async getHtml(p) {
      const res = await fetch(base + p, { headers: cookie ? { cookie } : {}, redirect: 'manual' });
      remember(res);
      return { status: res.status, text: res.status < 300 ? await res.text() : '' };
    },
    // Posts a form with the CSRF token taken from `page`, then reads the page
    // it redirects to, so the flash message that explains a refusal is seen.
    async submit(page, p, form) {
      const csrf = csrfOf((await this.getHtml(page)).text);
      const body = new URLSearchParams();
      for (const [k, v] of Object.entries({ ...form, _csrf: csrf })) {
        for (const one of Array.isArray(v) ? v : [v]) body.append(k, one);
      }
      const res = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) }, body: body.toString(), redirect: 'manual' });
      remember(res);
      // Read the body before following the redirect: express-session sends
      // the headers before it has finished saving the session, so following
      // on headers alone can fetch the next page before the flash is stored.
      await res.text();
      const location = res.headers.get('location');
      const next = res.status === 302 && location ? await this.getHtml(location) : { text: '' };
      return { status: res.status, location, text: next.text };
    },
  };
}
const uniqueEmail = (tag) => `${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
function csrfOf(html) {
  const m = html.match(/name="_csrf" value="([^"]*)"/);
  return m ? m[1] : null;
}
async function signedInChurch(tag) {
  const c = client();
  const signup = await c.postJson('/signup', { churchName: `${tag} Church`, name: 'Admin Person', email: uniqueEmail(tag), password: 'Tr0ubadour-7!' });
  assert.strictEqual(signup.status, 201);
  createdChurchIds.push(signup.body.church.id);
  return { admin: c, churchId: signup.body.church.id };
}
async function financeUser(churchId, financeRole, role = 'VIEWER') {
  const email = uniqueEmail(financeRole.toLowerCase());
  await db.user.create({ data: { churchId, username: `${financeRole.toLowerCase()}-${Date.now()}-${Math.random()}`, email, passwordHash: await bcrypt.hash('Tr0ubadour-7!', 4), role, financeRole } });
  const c = client();
  const login = await c.postJson('/login', { email, password: 'Tr0ubadour-7!' });
  assert.strictEqual(login.status, 200);
  return c;
}
const cash = (churchId) => ledger.assetBalance(tenantDb(churchId), churchId, ledger.ACC.CASH);
const today = () => new Date().toISOString().slice(0, 10);

// Two general-income receipts, a tithe, a day-born collection and a service,
// all recorded through the real routes so each posts Dr Cash as it would live.
async function recordCollections(admin, churchId) {
  const member = await db.member.create({ data: { churchId, firstName: 'Ama', lastName: 'Owusu' } });
  const serviceType = await db.serviceType.findFirst({ where: { churchId } });
  await admin.submit('/finance/income', '/finance/income', { transactionDate: today(), category: 'donation', amount: '120.50', receivedFrom: 'First giver' });
  await admin.submit('/finance/income', '/finance/income', { transactionDate: today(), category: 'donation', amount: '79.50', receivedFrom: 'Second giver' });
  await admin.submit('/finance/tithes', '/finance/tithes', { memberId: String(member.id), titheDate: today(), amount: '50' });
  await admin.submit('/finance/day-borns', '/finance/day-borns', { collectionDate: today(), dayBorn: 'SUNDAY', amount: '30' });
  await admin.submit('/finance/services', '/finance/services', { serviceTypeId: String(serviceType.id), serviceDate: today(), totalAmount: '400' });
  const incomes = await db.incomeRecord.findMany({ where: { churchId }, orderBy: { id: 'asc' } });
  assert.strictEqual(incomes.length, 2);
  return { incomes, member };
}

test('a cash count is entered by denomination, refused when malformed, and verified only by another fund manager', async () => {
  const { admin, churchId } = await signedInChurch('cash-count');
  const cashier = await financeUser(churchId, 'CASHIER');
  const treasurer = await financeUser(churchId, 'TREASURER');

  const fractional = await cashier.submit('/finance/cash-counts', '/finance/cash-counts', { serviceDate: today(), collection: 'Sunday offering', countedBy: 'Ama, Esi', 'qty:NOTE-50': '3.5' });
  assert.match(fractional.text, /must be a whole number/);
  const empty = await cashier.submit('/finance/cash-counts', '/finance/cash-counts', { serviceDate: today(), collection: 'Sunday offering', countedBy: 'Ama, Esi' });
  assert.match(empty.text, /at least one note or coin/);
  assert.strictEqual(await db.cashCountSheet.count({ where: { churchId } }), 0, 'refused counts leave nothing behind');

  const saved = await cashier.submit('/finance/cash-counts', '/finance/cash-counts', {
    serviceDate: today(), serviceLabel: 'Sunday 1st service', collection: 'Sunday offering', expectedAmount: '565',
    countedBy: 'Ama, Esi', 'qty:NOTE-50': '10', 'qty:NOTE-20': '3', 'qty:COIN-0.5': '3',
  });
  assert.strictEqual(saved.status, 302);
  const sheet = await db.cashCountSheet.findFirst({ where: { churchId } });
  assert.strictEqual(sheet.sheetNo, `CC-${today().slice(0, 4)}-0001`);
  assert.strictEqual(sheet.countedAmount, 561.5);
  assert.strictEqual(sheet.status, 'COUNTED');
  assert.strictEqual(await db.cashCountLine.count({ where: { churchId, sheetId: sheet.id } }), 3);
  assert.match(saved.text, /Short GH₵ 3\.50/, 'the printed sheet shows the shortage');
  assert.strictEqual(await db.journalEntry.count({ where: { churchId } }), 0, 'a count posts nothing to the ledger');

  const csrf = csrfOf((await cashier.getHtml(`/finance/cash-counts/${sheet.id}`)).text);
  const byCashier = await fetch(`${base}/finance/cash-counts/${sheet.id}/verify`, { method: 'POST' }).then((r) => r.status);
  assert.ok([302, 403].includes(byCashier));
  assert.ok(csrf);

  const ownCount = await treasurer.submit('/finance/cash-counts', '/finance/cash-counts', { serviceDate: today(), collection: 'Tithes', countedBy: 'Grace', 'qty:NOTE-10': '2' });
  const own = await db.cashCountSheet.findFirst({ where: { churchId, collection: 'Tithes' } });
  assert.strictEqual(own.sheetNo, `CC-${today().slice(0, 4)}-0002`);
  const refused = await treasurer.submit(ownCount.location, `/finance/cash-counts/${own.id}/verify`, {});
  assert.match(refused.text, /cannot verify a cash count you entered yourself/);
  assert.strictEqual((await db.cashCountSheet.findUnique({ where: { id: own.id } })).status, 'COUNTED');

  const verified = await treasurer.submit(`/finance/cash-counts/${sheet.id}`, `/finance/cash-counts/${sheet.id}/verify`, {});
  assert.match(verified.text, /Cash count verified/);
  assert.strictEqual((await db.cashCountSheet.findUnique({ where: { id: sheet.id } })).status, 'VERIFIED');

  const noReason = await admin.submit(`/finance/cash-counts/${own.id}`, `/finance/cash-counts/${own.id}/void`, { reason: '' });
  assert.match(noReason.text, /reason is required/);
  await admin.submit(`/finance/cash-counts/${own.id}`, `/finance/cash-counts/${own.id}/void`, { reason: 'Entered twice' });
  const voided = await db.cashCountSheet.findUnique({ where: { id: own.id } });
  assert.strictEqual(voided.status, 'VOIDED');
  assert.strictEqual(voided.voidReason, 'Entered twice');
});

test('a cashier cannot verify, and a finance viewer cannot record', async () => {
  const { churchId } = await signedInChurch('cash-roles');
  const cashier = await financeUser(churchId, 'CASHIER');
  const auditor = await financeUser(churchId, 'AUDITOR');
  await cashier.submit('/finance/cash-counts', '/finance/cash-counts', { serviceDate: today(), collection: 'Other', countedBy: 'Kwame', 'qty:NOTE-5': '1' });
  const sheet = await db.cashCountSheet.findFirst({ where: { churchId } });
  const verify = await cashier.submit(`/finance/cash-counts/${sheet.id}`, `/finance/cash-counts/${sheet.id}/verify`, {});
  assert.strictEqual(verify.status, 403);
  assert.strictEqual((await auditor.getHtml('/finance/deposits')).status, 200, 'an auditor may read');
  const record = await auditor.submit('/finance/cash-counts', '/finance/cash-counts', { serviceDate: today(), collection: 'Other', countedBy: 'A', 'qty:NOTE-5': '1' });
  assert.strictEqual(record.status, 403);
  const viewer = await financeUser(churchId, 'NONE');
  assert.strictEqual((await viewer.getHtml('/finance/deposits')).status, 403);
});

test('a deposit banks the ticked collections, is verified by another fund manager, and posts Dr 1010 / Cr 1000', async () => {
  const { admin, churchId } = await signedInChurch('deposit');
  const cashier = await financeUser(churchId, 'CASHIER');
  const treasurer = await financeUser(churchId, 'TREASURER');
  const { incomes } = await recordCollections(admin, churchId);
  const tithe = await db.tithe.findFirst({ where: { churchId } });
  const service = await db.service.findFirst({ where: { churchId } });
  const dayBorn = await db.dayBornCollection.findFirst({ where: { churchId } });
  const cashBefore = await cash(churchId);
  assert.strictEqual(cashBefore, 680);

  const form = await cashier.getHtml('/finance/deposits');
  for (const key of [`INCOME:${incomes[0].id}`, `TITHE:${tithe.id}`, `DAYBORN:${dayBorn.id}`, `SERVICE:${service.id}`]) {
    assert.ok(form.text.includes(`value="${key}"`), `${key} is offered for banking`);
  }

  // The typed amount is ignored when collections are ticked: the total comes from the records.
  const saved = await cashier.submit('/finance/deposits', '/finance/deposits', {
    item: [`INCOME:${incomes[0].id}`, `INCOME:${incomes[1].id}`, `SERVICE:${service.id}`], amount: '1',
    depositDate: today(), bankName: 'GCB Bank', depositedBy: 'Kwame',
  });
  assert.match(saved.text, /saved as pending/);
  const deposit = await db.bankDeposit.findFirst({ where: { churchId } });
  assert.strictEqual(deposit.amount, 600);
  assert.strictEqual(deposit.status, 'PENDING');
  assert.strictEqual(deposit.depositNo, `DEP-${today().slice(0, 4)}-0001`);
  assert.deepStrictEqual((await db.incomeRecord.findMany({ where: { churchId }, orderBy: { id: 'asc' } })).map((r) => r.depositId), [deposit.id, deposit.id]);
  assert.strictEqual((await db.service.findUnique({ where: { id: service.id } })).depositId, deposit.id);
  assert.match(saved.text, /3 collections banked/);
  assert.ok(!(await cashier.getHtml('/finance/deposits')).text.includes(`value="INCOME:${incomes[0].id}"`), 'banked collections are no longer offered');

  const early = await treasurer.submit('/finance/deposits', `/finance/deposits/${deposit.id}/verify`, {});
  assert.match(early.text, /Only a deposit with a slip number/);

  await cashier.submit('/finance/deposits', `/finance/deposits/${deposit.id}/slip`, { slipNo: 'GCB-1001' });
  assert.strictEqual((await db.bankDeposit.findUnique({ where: { id: deposit.id } })).status, 'DEPOSITED');

  const byCashier = await cashier.submit('/finance/deposits', `/finance/deposits/${deposit.id}/verify`, {});
  assert.strictEqual(byCashier.status, 403);

  const verified = await treasurer.submit('/finance/deposits', `/finance/deposits/${deposit.id}/verify`, {});
  assert.match(verified.text, /Deposit verified and posted/);
  const after = await db.bankDeposit.findUnique({ where: { id: deposit.id } });
  assert.strictEqual(after.status, 'VERIFIED');
  const lines = await db.journalLine.findMany({ where: { churchId, entryId: after.journalEntryId }, include: { account: true } });
  assert.deepStrictEqual(lines.map((l) => [l.account.code, l.debit, l.credit]).sort(), [['1000', 0, 600], ['1010', 600, 0]]);
  assert.strictEqual(await cash(churchId), cashBefore - 600, 'cash in hand falls by what was banked');
});

test('the recorder of a deposit cannot verify it, and a deposit larger than cash in hand is refused', async () => {
  const { admin, churchId } = await signedInChurch('deposit-refusals');
  const treasurer = await financeUser(churchId, 'TREASURER');
  await recordCollections(admin, churchId);

  await treasurer.submit('/finance/deposits', '/finance/deposits', { amount: '50', depositDate: today(), bankName: 'GCB', slipNo: 'S-1', depositedBy: 'Grace' });
  const own = await db.bankDeposit.findFirst({ where: { churchId } });
  const self = await treasurer.submit('/finance/deposits', `/finance/deposits/${own.id}/verify`, {});
  assert.match(self.text, /cannot verify a deposit you recorded yourself/);

  await treasurer.submit('/finance/deposits', '/finance/deposits', { amount: '9999999', depositDate: today(), bankName: 'GCB', slipNo: 'S-2', depositedBy: 'Grace' });
  const big = await db.bankDeposit.findFirst({ where: { churchId, slipNo: 'S-2' } });
  const before = await db.journalEntry.count({ where: { churchId } });
  const refused = await admin.submit('/finance/deposits', `/finance/deposits/${big.id}/verify`, {});
  assert.match(refused.text, /more than the cash in hand/);
  assert.strictEqual((await db.bankDeposit.findUnique({ where: { id: big.id } })).status, 'DEPOSITED', 'left for correction');
  assert.strictEqual(await db.journalEntry.count({ where: { churchId } }), before, 'and nothing posted');
});

test('banked money cannot be reversed until its deposit is voided, and the deposit\'s own entry only through its void', async () => {
  const { admin, churchId } = await signedInChurch('deposit-guard');
  const cashier = await financeUser(churchId, 'CASHIER');
  const { incomes } = await recordCollections(admin, churchId);
  const service = await db.service.findFirst({ where: { churchId } });
  const dayBorn = await db.dayBornCollection.findFirst({ where: { churchId } });
  await cashier.submit('/finance/deposits', '/finance/deposits', {
    item: [`INCOME:${incomes[0].id}`, `SERVICE:${service.id}`, `DAYBORN:${dayBorn.id}`], depositDate: today(), bankName: 'GCB', slipNo: 'G-9', depositedBy: 'Kwame',
  });
  const deposit = await db.bankDeposit.findFirst({ where: { churchId } });
  await admin.submit('/finance/deposits', `/finance/deposits/${deposit.id}/verify`, {});
  const verified = await db.bankDeposit.findUnique({ where: { id: deposit.id } });
  assert.strictEqual(verified.status, 'VERIFIED');
  const cashAfterBanking = await cash(churchId);

  const archive = await admin.submit('/finance/income', `/finance/income/${incomes[0].id}/delete`, {});
  assert.match(archive.text, /Void that deposit first/);
  assert.strictEqual((await db.incomeRecord.findUnique({ where: { id: incomes[0].id } })).deletedAt, null);
  const serviceArchive = await admin.submit('/finance/services', `/finance/services/${service.id}/delete`, {});
  assert.match(serviceArchive.text, /Void that deposit first/);
  assert.strictEqual((await admin.del(`/api/finance/day-borns/${dayBorn.id}`)).status, 409);

  const incomeEntry = (await db.incomeRecord.findUnique({ where: { id: incomes[0].id } })).journalEntryId;
  const manual = await admin.submit(`/finance/journal/${incomeEntry}`, `/finance/journal/${incomeEntry}/reverse`, { reason: 'try' });
  assert.match(manual.text, /Void that deposit first/);
  const depositEntry = await admin.submit(`/finance/journal/${verified.journalEntryId}`, `/finance/journal/${verified.journalEntryId}/reverse`, { reason: 'try' });
  assert.match(depositEntry.text, /Void the deposit instead/);
  assert.strictEqual((await db.journalEntry.findUnique({ where: { id: verified.journalEntryId } })).status, 'POSTED');
  assert.strictEqual(await cash(churchId), cashAfterBanking, 'nothing moved');

  // Voiding the deposit reverses its entry and releases the collections.
  await admin.submit('/finance/deposits', `/finance/deposits/${deposit.id}/void`, { reason: 'Wrong account' });
  assert.strictEqual((await db.bankDeposit.findUnique({ where: { id: deposit.id } })).status, 'VOIDED');
  assert.strictEqual((await db.journalEntry.findUnique({ where: { id: verified.journalEntryId } })).status, 'REVERSED');
  assert.strictEqual(await cash(churchId), cashAfterBanking + deposit.amount, 'cash in hand restored exactly');
  assert.strictEqual((await db.incomeRecord.findUnique({ where: { id: incomes[0].id } })).depositId, null);
  assert.ok((await cashier.getHtml('/finance/deposits')).text.includes(`value="INCOME:${incomes[0].id}"`), 'offered for banking again');

  const nowArchivable = await admin.submit('/finance/income', `/finance/income/${incomes[0].id}/delete`, {});
  assert.match(nowArchivable.text, /reversed and archived/);
});

test('the same collection cannot be banked twice, and an archived one cannot be banked at all', async () => {
  const { admin, churchId } = await signedInChurch('deposit-twice');
  const cashier = await financeUser(churchId, 'CASHIER');
  const { incomes } = await recordCollections(admin, churchId);
  await cashier.submit('/finance/deposits', '/finance/deposits', { item: `INCOME:${incomes[0].id}`, depositDate: today(), bankName: 'GCB', depositedBy: 'Kwame' });
  const second = await admin.submit('/finance/deposits', '/finance/deposits', { item: [`INCOME:${incomes[0].id}`, `INCOME:${incomes[1].id}`], depositDate: today(), bankName: 'GCB', depositedBy: 'Kwame' });
  assert.match(second.text, /banked by someone else/);
  assert.strictEqual(await db.bankDeposit.count({ where: { churchId } }), 1, 'the second deposit was not created');
  assert.strictEqual((await db.incomeRecord.findUnique({ where: { id: incomes[1].id } })).depositId, null, 'and took nothing with it');

  await admin.submit('/finance/income', `/finance/income/${incomes[1].id}/delete`, {});
  const archived = await admin.submit('/finance/deposits', '/finance/deposits', { item: `INCOME:${incomes[1].id}`, depositDate: today(), bankName: 'GCB', depositedBy: 'Kwame' });
  assert.match(archived.text, /have been reversed/);
});

test('another church\'s counts and deposits cannot be read, verified or ticked', async () => {
  const a = await signedInChurch('cash-tenant-a');
  const b = await signedInChurch('cash-tenant-b');
  const { incomes } = await recordCollections(a.admin, a.churchId);
  const aCashier = await financeUser(a.churchId, 'CASHIER');
  await aCashier.submit('/finance/cash-counts', '/finance/cash-counts', { serviceDate: today(), collection: 'Other', countedBy: 'A', 'qty:NOTE-5': '1' });
  await aCashier.submit('/finance/deposits', '/finance/deposits', { item: `INCOME:${incomes[0].id}`, depositDate: today(), bankName: 'GCB', slipNo: 'X', depositedBy: 'A' });
  const sheet = await db.cashCountSheet.findFirst({ where: { churchId: a.churchId } });
  const deposit = await db.bankDeposit.findFirst({ where: { churchId: a.churchId } });

  assert.strictEqual((await b.admin.getHtml(`/finance/cash-counts/${sheet.id}`)).status, 404);
  assert.strictEqual((await b.admin.submit('/finance/cash-counts', `/finance/cash-counts/${sheet.id}/verify`, {})).status, 404);
  assert.strictEqual((await b.admin.submit('/finance/deposits', `/finance/deposits/${deposit.id}/verify`, {})).status, 404);
  assert.strictEqual((await b.admin.submit('/finance/deposits', `/finance/deposits/${deposit.id}/void`, { reason: 'x' })).status, 404);
  assert.ok(!(await b.admin.getHtml('/finance/deposits')).text.includes(deposit.depositNo), 'not listed to church B');

  const stolen = await b.admin.submit('/finance/deposits', '/finance/deposits', { item: `INCOME:${incomes[1].id}`, depositDate: today(), bankName: 'GCB', depositedBy: 'B' });
  assert.match(stolen.text, /banked by someone else|have been reversed/);
  assert.strictEqual(await db.bankDeposit.count({ where: { churchId: b.churchId } }), 0);
  assert.strictEqual((await db.incomeRecord.findUnique({ where: { id: incomes[1].id } })).depositId, null);
  assert.strictEqual((await db.cashCountSheet.findUnique({ where: { id: sheet.id } })).status, 'COUNTED');
  assert.strictEqual((await db.bankDeposit.findUnique({ where: { id: deposit.id } })).status, 'DEPOSITED');
});
