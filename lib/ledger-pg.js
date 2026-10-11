'use strict';
// Phase 5: Postgres/Prisma port of lib/ledger.js — the double-entry ledger
// engine. This is the highest-stakes port in the whole rewrite (real money,
// atomicity, concurrency), so it gets extra scrutiny beyond the usual
// mechanical conversion:
//
// 1. Every write path (postJournal, reverseJournal) ALWAYS runs inside a
//    Prisma interactive $transaction — callers pass a scoped tenantDb(church)
//    client and this module opens its own transaction, mirroring the
//    original's `db.transaction(() => {...})()` pattern but async.
// 2. NEW correctness concern that has NO SQLite equivalent (flagged in the
//    original migration plan): SQLite's single-writer serialization made
//    period-lock races structurally impossible. Postgres's default READ
//    COMMITTED isolation does NOT — two concurrent postJournal calls could
//    both read a period as OPEN and both proceed. ensurePeriod() below uses
//    `SELECT ... FOR UPDATE` (raw SQL, manually churchId-scoped per the
//    Phase-4 guardrail — see scripts/check-raw-sql-tenant-scoping.js, which
//    is extended to also scan this file) to serialize concurrent postJournal
//    calls against the same period row, with a create+retry-on-conflict
//    fallback for the "first entry ever in this period" case where there's
//    nothing to lock yet.
// 3. Per-church sequential journal numbering (JV-2026-000001) can also
//    collide under concurrency; postJournal retries entry-number generation
//    on a unique-constraint conflict rather than assuming its first read is
//    still valid by the time it writes.

const { Prisma } = require('@prisma/client');

// A ledger refusal the user can act on (locked period, unbalanced entry,
// already reversed, banked money). `expose` lets the global error handler show
// the message and answer 409 instead of a generic 500.
class LedgerError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LedgerError';
    this.expose = true;
    this.status = 409;
  }
}

const ACC = {
  CASH: '1000',
  BANK_CLEARING: '1010',
  RECEIVABLES: '1100',
  FUND_BALANCE: '3000',
  TITHES: '4000',
  OFFERTORY: '4010',
  DAYBORNS: '4020',
  HARVEST: '4030',
  SPECIAL: '4040',
  DONATIONS: '4050',
  PLEDGES: '4060',
  EVENT_INCOME: '4070',
  OTHER_INCOME: '4900',
  UTILITIES: '5000',
  ADMIN: '5010',
  MINISTERIAL: '5020',
  WELFARE: '5030',
  REPAIRS: '5040',
  EVENT_EXPENSE: '5050',
  MUSIC: '5060',
  MISSION: '5070',
  YOUTH: '5080',
  CHILDREN: '5090',
  BANK_CHARGES: '5100',
  EQUIPMENT: '5110',
  PRINTING: '5120',
  TRANSPORT: '5130',
  REFRESHMENT: '5140',
  OTHER_EXPENSE: '5900',
};

function incomeAccountFor(category) {
  const c = String(category || '').toLowerCase();
  if (c.includes('tithe')) return ACC.TITHES;
  if (c.includes('day-born') || c.includes('day born')) return ACC.DAYBORNS;
  if (c.includes('harvest')) return ACC.HARVEST;
  if (c.includes('special')) return ACC.SPECIAL;
  if (c.includes('pledge')) return ACC.PLEDGES;
  if (c.includes('donation')) return ACC.DONATIONS;
  if (c.includes('anniversary') || c.includes('event')) return ACC.EVENT_INCOME;
  if (c.includes('offertory') || c.includes('collection') || c.includes('offering')) return ACC.OFFERTORY;
  return ACC.OTHER_INCOME;
}

function expenseAccountFor(category) {
  const c = String(category || '').toLowerCase();
  // The seeded categories (lib/provision.js) must each land on the account
  // they are named for: "Salaries", "Office Supplies" and "Outreach" matched
  // none of the keywords below and silently fell through to Other expenses.
  if (c.includes('ministerial') || c.includes('salar')) return ACC.MINISTERIAL;
  if (c.includes('admin')) return ACC.ADMIN;
  if (c.includes('utilit')) return ACC.UTILITIES;
  if (c.includes('repair') || c.includes('maintenance')) return ACC.REPAIRS;
  if (c.includes('welfare') || c.includes('benevolence')) return ACC.WELFARE;
  if (c.includes('mission') || c.includes('evangel') || c.includes('outreach')) return ACC.MISSION;
  if (c.includes('music') || c.includes('choir')) return ACC.MUSIC;
  if (c.includes('youth')) return ACC.YOUTH;
  if (c.includes('children')) return ACC.CHILDREN;
  if (c.includes('stationery') || c.includes('printing') || c.includes('office')) return ACC.PRINTING;
  if (c.includes('transport')) return ACC.TRANSPORT;
  if (c.includes('refreshment')) return ACC.REFRESHMENT;
  if (c.includes('event') || c.includes('anniversary')) return ACC.EVENT_EXPENSE;
  if (c.includes('bank')) return ACC.BANK_CHARGES;
  if (c.includes('equipment')) return ACC.EQUIPMENT;
  return ACC.OTHER_EXPENSE;
}

function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function normalizeDate(value) {
  const s = value instanceof Date ? value.toISOString().slice(0, 10) : String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new LedgerError('Journal date must be YYYY-MM-DD.');
  return s;
}

// Raw SQL, manually churchId-scoped (see module header). Locks the period
// row for the duration of the enclosing transaction so a concurrent
// postJournal against the same period cannot proceed until this one commits
// or rolls back.
async function lockPeriod(tx, churchId, year, month) {
  const rows = await tx.$queryRaw`
    SELECT period_id, status FROM financial_periods
    WHERE church_id = ${churchId} AND year = ${year} AND month = ${month}
    FOR UPDATE
  `;
  return rows[0] || null;
}

// PostgreSQL marks a transaction as aborted after any unique-constraint
// violation, so "catch P2002 and retry inside the same transaction" is not a
// valid concurrency strategy. Serialize journal-number allocation per
// church/year before creating a first period or entry number. The lock is
// transaction-scoped and releases automatically on commit/rollback.
async function lockJournalSequence(tx, churchId, year) {
  await tx.$queryRaw`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${'journal:' + churchId + ':' + year}, 0)
    )::text AS locked
  `;
}

async function ensurePeriod(tx, churchId, dateStr) {
  const year = Number(dateStr.slice(0, 4));
  const month = Number(dateStr.slice(5, 7));
  const existing = await lockPeriod(tx, churchId, year, month);
  if (existing) return { id: existing.period_id, status: existing.status };
  try {
    const created = await tx.financialPeriod.create({ data: { churchId, year, month } });
    return { id: created.id, status: created.status };
  } catch (e) {
    // Lost the create race to a concurrent transaction — refetch (now
    // FOR UPDATE-locked, so this blocks until the winner commits).
    if (e.code === 'P2002') {
      const retry = await lockPeriod(tx, churchId, year, month);
      return { id: retry.period_id, status: retry.status };
    }
    throw e;
  }
}

async function nextJournalNo(tx, year) {
  const prefix = `JV-${year}-`;
  const last = await tx.journalEntry.findFirst({
    where: { entryNo: { startsWith: prefix } },
    orderBy: { entryNo: 'desc' },
  });
  const next = last ? Number(String(last.entryNo).slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(next).padStart(6, '0')}`;
}

/**
 * Post a balanced journal entry. `tx` must be an already-open transaction
 * client (i.e. called from inside `db.$transaction(async (tx) => ...)`),
 * never the bare scoped client — every caller in this module opens its own
 * transaction around a postJournal() call.
 */
async function postJournal(tx, churchId, params) {
  const lines = params.lines || [];
  if (!lines.length) throw new LedgerError('Journal entry requires at least one line.');
  const debit = roundMoney(lines.reduce((sum, l) => sum + Number(l.debit || 0), 0));
  const credit = roundMoney(lines.reduce((sum, l) => sum + Number(l.credit || 0), 0));
  if (debit <= 0 || credit <= 0 || debit !== credit) {
    throw new LedgerError(`Unbalanced journal entry: debits ${debit} != credits ${credit}.`);
  }

  const date = normalizeDate(params.date);
  await lockJournalSequence(tx, churchId, date.slice(0, 4));
  const period = await ensurePeriod(tx, churchId, date);
  if (period.status === 'LOCKED') throw new LedgerError('This financial period is locked.');

  const codes = [...new Set(lines.map((l) => l.accountCode))];
  const accounts = await tx.account.findMany({ where: { code: { in: codes }, active: true } });
  const byCode = new Map(accounts.map((a) => [a.code, a]));
  for (const code of codes) {
    if (!byCode.has(code)) throw new LedgerError(`Chart of accounts missing account code ${code}.`);
  }

  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    const entryNo = await nextJournalNo(tx, date.slice(0, 4));
    try {
      const entry = await tx.journalEntry.create({
        data: {
          entryNo,
          entryDate: new Date(date),
          memo: params.memo || null,
          sourceType: params.sourceType || 'OTHER',
          sourceId: params.sourceId == null ? null : String(params.sourceId),
          periodId: period.id,
          createdBy: params.createdBy || null,
        },
      });
      // Deliberately NOT a nested `lines: { create: [...] }` write — the
      // tenantDb extension only auto-stamps churchId on the TOP-LEVEL
      // create() call, never into nested relational writes, so a nested
      // JournalLine create would be missing its required churchId. Two
      // flat creates inside the same `tx` are just as atomic and side-step
      // the footgun entirely; this is the pattern to follow anywhere else a
      // one-to-many nested write might otherwise seem convenient.
      await tx.journalLine.createMany({
        data: lines.map((l) => ({
          churchId,
          entryId: entry.id,
          accountId: byCode.get(l.accountCode).id,
          fundId: l.fundId || null,
          debit: Number(l.debit || 0),
          credit: Number(l.credit || 0),
          memo: l.memo || null,
        })),
      });
      return entry.id;
    } catch (e) {
      if (e.code === 'P2002') { lastErr = e; continue; } // entryNo collision — retry with a fresh number
      throw e;
    }
  }
  throw lastErr;
}

async function postCashIncome(db, churchId, opts) {
  return db.$transaction(async (tx) => postJournal(tx, churchId, {
    date: opts.date,
    memo: opts.memo,
    sourceType: opts.sourceType,
    sourceId: opts.sourceId,
    createdBy: opts.createdBy,
    lines: [
      { accountCode: ACC.CASH, debit: opts.amount, fundId: opts.fundId },
      { accountCode: opts.incomeAccount || incomeAccountFor(opts.category), credit: opts.amount, fundId: opts.fundId },
    ],
  }), { timeout: 15000, maxWait: 15000 });
}

async function postExpensePayment(db, churchId, opts) {
  return db.$transaction(async (tx) => postJournal(tx, churchId, {
    date: opts.date,
    memo: opts.memo,
    sourceType: 'EXPENSE',
    sourceId: opts.sourceId,
    createdBy: opts.createdBy,
    lines: [
      { accountCode: opts.expenseAccount || expenseAccountFor(opts.category), debit: opts.amount, fundId: opts.fundId },
      { accountCode: ACC.CASH, credit: opts.amount, fundId: opts.fundId },
    ],
  }), { timeout: 15000, maxWait: 15000 });
}

// Collections that can be ticked on a bank deposit, by the sourceType their
// journal entry carries. Reversing one while its deposit stands would leave
// the deposit claiming money the books no longer hold.
const BANKABLE_SOURCES = {
  GENERIC_INCOME: 'incomeRecord',
  TITHE: 'tithe',
  DAY_BORN_COLLECTION: 'dayBornCollection',
  SERVICE: 'service',
};

/**
 * Throws if reversing this entry would undo money a bank deposit relies on.
 * Lives here, inside reverseJournal's transaction, so it holds for every
 * caller: the archive routes (HTML and JSON) and the manual "reverse journal
 * entry" route alike. Routes check first as well, for a friendlier message.
 */
async function assertNotBanked(tx, original) {
  const id = Number(original.sourceId);
  if (!Number.isInteger(id)) return;
  if (original.sourceType === 'BANK_DEPOSIT') {
    const deposit = await tx.bankDeposit.findUnique({ where: { id } });
    // The deposit's own void marks it VOIDED before reversing its entry;
    // anything else reversing it would leave a VERIFIED deposit unposted.
    if (deposit && deposit.status !== 'VOIDED') {
      throw new LedgerError(`This entry posts deposit ${deposit.depositNo}. Void the deposit instead.`);
    }
    return;
  }
  const model = BANKABLE_SOURCES[original.sourceType];
  if (!model) return;
  const row = await tx[model].findUnique({ where: { id } });
  if (row && row.depositId) {
    const deposit = await tx.bankDeposit.findUnique({ where: { id: row.depositId } });
    throw new LedgerError(`This money was taken to the bank on deposit ${deposit ? deposit.depositNo : '#' + row.depositId}. Void that deposit first.`);
  }
}

async function reverseJournal(db, churchId, entryId, reason, createdBy) {
  return db.$transaction(async (tx) => {
    // Claim the entry atomically BEFORE reading it. A plain read-then-check
    // lets two concurrent reversals both see POSTED and both post a mirror
    // entry; the conditional update takes the row lock, so the second caller
    // waits, re-evaluates the WHERE, and matches nothing. Any later failure
    // in this transaction rolls the claim back.
    const claimed = await tx.journalEntry.updateMany({ where: { id: entryId, status: 'POSTED' }, data: { status: 'REVERSED' } });
    if (claimed.count !== 1) {
      const exists = await tx.journalEntry.findUnique({ where: { id: entryId }, select: { status: true } });
      throw new LedgerError(exists ? 'Entry already reversed.' : 'Journal entry not found.');
    }
    const original = await tx.journalEntry.findUnique({ where: { id: entryId }, include: { lines: true } });
    await assertNotBanked(tx, original);

    const accountIds = [...new Set(original.lines.map((l) => l.accountId))];
    const accounts = await tx.account.findMany({ where: { id: { in: accountIds } } });
    const codeById = new Map(accounts.map((a) => [a.id, a.code]));

    const reversalId = await postJournal(tx, churchId, {
      date: new Date().toISOString().slice(0, 10),
      memo: `Reversal of ${original.entryNo}: ${reason || 'No reason provided'}`,
      sourceType: original.sourceType,
      sourceId: original.sourceId,
      createdBy,
      lines: original.lines.map((l) => ({
        accountCode: codeById.get(l.accountId),
        fundId: l.fundId,
        debit: l.credit,
        credit: l.debit,
        memo: l.memo ? `Reversal: ${l.memo}` : 'Reversal',
      })),
    });
    await tx.journalEntry.update({ where: { id: reversalId }, data: { reversesId: entryId } });
    return reversalId;
  }, { timeout: 15000, maxWait: 15000 });
}

/**
 * Approve a SUBMITTED expense and post its payment in ONE transaction.
 * The conditional update is the claim: a double-click or two approvers racing
 * both pass the caller's status check, but only one matches
 * approvalStatus = 'SUBMITTED' here; the other gets null and nothing is posted.
 * Returns the updated expense, or null if it was no longer awaiting approval.
 */
async function approveAndPayExpense(db, churchId, expense, approverId) {
  return db.$transaction(async (tx) => {
    const now = new Date();
    // The claim also matches the amount, date, fund and category the approver
    // actually saw (and the tier check was made against). An edit that lands
    // between that read and this write changes one of them, so the claim
    // fails instead of paying an amount nobody approved.
    const claimed = await tx.expense.updateMany({
      where: {
        id: expense.id, approvalStatus: 'SUBMITTED',
        amount: expense.amount, spentOn: expense.spentOn, fundId: expense.fundId, category: expense.category,
      },
      data: { approvalStatus: 'PAID', approvedBy: approverId, approvedAt: now, paidAt: now },
    });
    if (claimed.count !== 1) return null;
    const entryId = await postJournal(tx, churchId, {
      date: expense.spentOn.toISOString().slice(0, 10),
      memo: expense.description || expense.category,
      sourceType: 'EXPENSE',
      sourceId: expense.id,
      createdBy: approverId,
      lines: [
        { accountCode: expenseAccountFor(expense.category), debit: Number(expense.amount), fundId: expense.fundId },
        { accountCode: ACC.CASH, credit: Number(expense.amount), fundId: expense.fundId },
      ],
    });
    return tx.expense.update({ where: { id: expense.id }, data: { journalEntryId: entryId } });
  }, { timeout: 15000, maxWait: 15000 });
}

// Raw SQL, manually churchId-scoped (see module header + the guardrail).
// All-time balance of a debit-normal asset account (e.g. 1000 Cash in hand):
// debits minus credits over posted and reversed entries, which is how a
// reversal and its mirror cancel.
async function assetBalance(db, churchId, code) {
  const rows = await db.$queryRaw`
    SELECT COALESCE(SUM(jl.debit), 0) AS debit, COALESCE(SUM(jl.credit), 0) AS credit
    FROM journal_lines jl
    JOIN accounts a ON a.account_id = jl.account_id
    JOIN journal_entries je ON je.entry_id = jl.entry_id
    WHERE jl.church_id = ${churchId} AND a.church_id = ${churchId} AND a.code = ${code}
      AND je.status IN ('POSTED', 'REVERSED')
  `;
  const row = rows[0] || {};
  return roundMoney(Number(row.debit || 0) - Number(row.credit || 0));
}

// Raw SQL, manually churchId-scoped (see module header + the guardrail).
async function fundBalance(db, churchId, fundId) {
  const fund = await db.fund.findUnique({ where: { id: fundId }, select: { openingBalance: true } });
  if (!fund) return 0;
  const rows = await db.$queryRaw`
    SELECT a.account_type, jl.debit, jl.credit
    FROM journal_lines jl
    JOIN accounts a ON a.account_id = jl.account_id
    JOIN journal_entries je ON je.entry_id = jl.entry_id
    WHERE jl.church_id = ${churchId} AND jl.fund_id = ${fundId} AND je.status IN ('POSTED', 'REVERSED')
  `;
  return roundMoney(rows.reduce((balance, row) => {
    if (row.account_type === 'INCOME') return balance + Number(row.credit) - Number(row.debit);
    if (row.account_type === 'EXPENSE') return balance - Number(row.debit) + Number(row.credit);
    return balance;
  }, Number(fund.openingBalance || 0)));
}

async function fundRaisedSpent(db, churchId, fundId) {
  const rows = await db.$queryRaw`
    SELECT a.account_type, jl.debit, jl.credit
    FROM journal_lines jl
    JOIN accounts a ON a.account_id = jl.account_id
    JOIN journal_entries je ON je.entry_id = jl.entry_id
    WHERE jl.church_id = ${churchId} AND jl.fund_id = ${fundId} AND je.status IN ('POSTED', 'REVERSED')
  `;
  let raised = 0, spent = 0;
  for (const row of rows) {
    if (row.account_type === 'INCOME') raised += Number(row.credit) - Number(row.debit);
    if (row.account_type === 'EXPENSE') spent += Number(row.debit) - Number(row.credit);
  }
  return { raised: roundMoney(raised), spent: roundMoney(spent) };
}

// The (from, to) date range a budget line's "actual" should be summed over —
// the full calendar year for an ANNUAL-scope budget, or one calendar month
// for MONTHLY scope. Pure JS/Date logic, no SQL — direct port of the
// original's budgetWindow().
function budgetWindow({ scope, year, month }) {
  if (scope === 'MONTHLY' && Number(month)) {
    const m = String(Number(month)).padStart(2, '0');
    const lastDay = new Date(Number(year), Number(month), 0).getDate();
    return { from: `${year}-${m}-01`, to: `${year}-${m}-${String(lastDay).padStart(2, '0')}` };
  }
  return { from: `${year}-01-01`, to: `${year}-12-31` };
}

// Actual income/expense for one budget line, summed straight from the
// ledger (journal_lines/journal_entries/accounts) — same source tables as
// fundBalance/fundRaisedSpent, not from expenses/income_records directly.
// Direct port of the original's budgetActual(). `lineType` is 'INCOME' or
// 'EXPENSE' (maps onto accounts.account_type); accountId/fundId narrow the
// sum to one account/fund when the line specifies them, otherwise "all
// accounts of that type" / "all funds".
async function budgetActual(db, churchId, { lineType, accountId, fundId, from, to }) {
  const rows = await db.$queryRaw`
    SELECT jl.debit, jl.credit
    FROM journal_lines jl
    JOIN accounts a ON a.account_id = jl.account_id
    JOIN journal_entries je ON je.entry_id = jl.entry_id
    WHERE jl.church_id = ${churchId}
      AND je.status IN ('POSTED', 'REVERSED')
      AND je.entry_date >= ${new Date(from)}::date AND je.entry_date <= ${new Date(to)}::date
      AND a.account_type = ${lineType}::"AccountType"
      ${accountId ? Prisma.sql`AND jl.account_id = ${accountId}` : Prisma.empty}
      ${fundId ? Prisma.sql`AND jl.fund_id = ${fundId}` : Prisma.empty}
  `;
  let actual = 0;
  for (const row of rows) {
    actual += lineType === 'INCOME' ? Number(row.credit) - Number(row.debit) : Number(row.debit) - Number(row.credit);
  }
  return roundMoney(actual);
}

/**
 * True when the financial period containing dateStr is LOCKED. Read-only: it
 * never creates the period row or takes its lock, so it is safe to call before
 * creating a record. Recording routes use it to refuse up front instead of
 * creating a row and then failing when postJournal throws on the lock.
 */
async function isPeriodLocked(db, dateStr) {
  const d = String(dateStr || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const period = await db.financialPeriod.findFirst({ where: { year: Number(d.slice(0, 4)), month: Number(d.slice(5, 7)), status: 'LOCKED' } });
  return !!period;
}

module.exports = {
  LedgerError,
  ACC,
  BANKABLE_SOURCES,
  assetBalance,
  isPeriodLocked,
  incomeAccountFor,
  expenseAccountFor,
  postJournal,
  postCashIncome,
  postExpensePayment,
  reverseJournal,
  approveAndPayExpense,
  fundBalance,
  fundRaisedSpent,
  budgetWindow,
  budgetActual,
  ensurePeriod,
};
