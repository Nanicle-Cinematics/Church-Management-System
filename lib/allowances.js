'use strict';
// Monthly allowances (Finance > Allowances). Each month, on the due day set in
// Finance settings, every active allowance becomes a submitted expense that
// goes through the normal approval and payment-voucher flow. Treasurers,
// Finance admins and Admins are alerted on the dashboard, by email, by text
// message and on any device where they turned notifications on; if any are
// still unpaid five days later they are reminded once.
//
// The scheduler (lib/operations-scheduler.js) calls runDueAllowances() and
// sendAllowanceReminders() every hour. Both are safe to run from several app
// machines at once: a month's run is unique per church, and a reminder is
// claimed with a conditional update before it is sent.

const { db: rawDb, tenantDb } = require('./tenant');
const { fmtMoney } = require('./format');
const { normalizePhone } = require('./phone');
const { sendSmsBatch, sendEmailEach } = require('./delivery');
const { pushToUsers } = require('./push');
const { logActivity } = require('./tenant-activity');

const DAY_MS = 24 * 60 * 60 * 1000;
const CATCH_UP_DAYS = 3; // a run missed while the app was down still happens
const REMIND_AFTER_DAYS = 5;
const ALERT_FINANCE_ROLES = ['FINANCE_ADMIN', 'TREASURER'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const periodOf = (d) => d.toISOString().slice(0, 7);
const periodLabel = (period) => `${MONTHS[Number(period.slice(5, 7)) - 1]} ${period.slice(0, 4)}`;
const daysInMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate(); // month is 1-12

/** The date allowances fall due in a month: the due day, or the last day of a shorter month. */
function dueDateFor(period, dueDay) {
  const y = Number(period.slice(0, 4));
  const m = Number(period.slice(5, 7));
  return new Date(Date.UTC(y, m - 1, Math.min(dueDay, daysInMonth(y, m))));
}

/** Is `now` on the due day, or within the catch-up days after it? Times are UTC (Ghana time). */
function isDue(now, dueDay) {
  if (!dueDay) return false;
  const due = dueDateFor(periodOf(now), dueDay);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return today >= due.getTime() && today <= due.getTime() + CATCH_UP_DAYS * DAY_MS;
}

/**
 * Draft this month's allowance expenses for one church. Returns the run, or
 * null when the month was already drafted or no allowance is active.
 * `createdBy` is the user who pressed "Draft now", or null for the scheduler.
 */
async function createRun(churchId, period, { createdBy = null, now = new Date() } = {}) {
  const db = tenantDb(churchId);
  if (await db.allowanceRun.findFirst({ where: { period } })) return null;
  const allowances = await db.allowance.findMany({ where: { active: true }, orderBy: { payeeName: 'asc' } });
  if (!allowances.length) return null;
  const fallbackFund = await db.fund.findFirst({ where: { active: true }, orderBy: { id: 'asc' } });
  const fallbackCat = await db.expenseCategory.findFirst({ where: { categoryName: { equals: 'Allowances', mode: 'insensitive' } } });
  const label = periodLabel(period);
  const total = allowances.reduce((sum, a) => sum + Number(a.amount), 0);
  const spentOn = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  try {
    return await db.$transaction(async (tx) => {
      const run = await tx.allowanceRun.create({ data: { period, workerCount: allowances.length, total, createdBy } });
      for (const a of allowances) {
        const catId = a.expenseCatId || (fallbackCat && fallbackCat.id) || null;
        const cat = catId ? await tx.expenseCategory.findUnique({ where: { id: catId } }) : null;
        await tx.expense.create({
          data: {
            expenseCatId: cat ? cat.id : null,
            category: cat ? cat.categoryName : 'Allowances',
            amount: Number(a.amount),
            spentOn,
            description: `Allowance – ${label}${a.role ? ` (${a.role})` : ''}`,
            paidTo: a.payeeName,
            fundId: a.fundId || (fallbackFund && fallbackFund.id) || null,
            approvalStatus: 'SUBMITTED',
            submittedAt: now,
            recordedBy: null, // drafted by the system, so any fund manager may approve it
            allowanceId: a.id,
            allowanceRunId: run.id,
          },
        });
      }
      return run;
    });
  } catch (e) {
    if (e.code === 'P2002') return null; // another machine drafted this month first
    throw e;
  }
}

/** Treasurers, Finance admins and Admins of a church: the people who approve and pay. */
async function alertRecipients(churchId) {
  return rawDb.user.findMany({
    where: { churchId, deletedAt: null, OR: [{ role: 'ADMIN' }, { financeRole: { in: ALERT_FINANCE_ROLES } }] },
    select: { id: true, email: true, phone: true, displayName: true, username: true },
  });
}

const isRealEmail = (e) => e && !/^(deleted|released)\+/.test(e);

/** Every number to text: alert recipients' sign-in phones plus the extra numbers in Finance settings. */
function smsNumbers(users, extraPhones) {
  const out = new Set();
  for (const u of users) if (u.phone && u.phone.startsWith('+')) out.add(u.phone);
  for (const raw of String(extraPhones || '').split(/[,;\n]/)) {
    const n = raw.trim() ? normalizePhone(raw.trim()) : null;
    if (n) out.add(n);
  }
  return [...out];
}

/**
 * Alert people on every channel: email, text message and device
 * notification. Each channel is tried on its own; one failing never stops
 * the others. `extraPhones` is a comma-separated list of numbers to text as
 * well. Returns what happened on each channel.
 */
async function alertUsers(churchId, users, { title, text, url, extraPhones = '' }) {
  const church = await rawDb.church.findUnique({ where: { id: churchId }, select: { name: true } });
  const link = `${(process.env.PUBLIC_URL || '').replace(/\/$/, '')}${url}`;
  const result = { email: null, sms: null, push: null };
  const emails = users.filter((u) => isRealEmail(u.email)).map((u) => ({ addr: u.email }));
  try {
    result.email = emails.length
      ? await sendEmailEach(tenantDb(churchId), emails, title, `${text}\n\nReview: ${link}`, { churchName: church && church.name, withFooter: false })
      : { ok: true, sent: 0 };
  } catch (e) { result.email = { ok: false, error: e.message }; }
  try {
    const numbers = smsNumbers(users, extraPhones);
    result.sms = numbers.length ? await sendSmsBatch(numbers, `${text} Review: ${link}`.slice(0, 320)) : { ok: true, sent: 0 };
  } catch (e) { result.sms = { ok: false, error: e.message }; }
  try {
    result.push = await pushToUsers(churchId, users.map((u) => u.id), { title, body: text, url });
  } catch (e) { result.push = { ok: false, error: e.message }; }
  return result;
}

/** Alert a church's Treasurers, Finance admins and Admins, plus the extra numbers in Finance settings. */
async function alertApprovers(churchId, message) {
  const settings = await rawDb.financeSetting.findUnique({ where: { churchId } });
  return alertUsers(churchId, await alertRecipients(churchId), { ...message, extraPhones: settings && settings.allowanceAlertPhones });
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Alert approvers that a month's allowances have been drafted. */
async function announceRun(churchId, run) {
  const label = periodLabel(run.period);
  const text = `${label} allowances are due: ${plural(run.workerCount, 'worker', 'workers')}, ${fmtMoney(run.total)}, waiting for approval.`;
  const result = await alertApprovers(churchId, { title: `${label} allowances are due`, text, url: '/finance/allowances' });
  await logActivity(tenantDb(churchId), 'allowance_run', `${label} allowances drafted for approval: ${plural(run.workerCount, 'worker', 'workers')}, ${fmtMoney(run.total)}`, '/finance/allowances', run.createdBy);
  return result;
}

/** Scheduler entry point: draft and announce this month's allowances for every church that is due. */
async function runDueAllowances(now = new Date()) {
  const due = await rawDb.financeSetting.findMany({
    where: { allowanceDueDay: { not: null }, church: { deletedAt: null, suspendedAt: null } },
    select: { churchId: true, allowanceDueDay: true },
  });
  const drafted = [];
  for (const s of due) {
    if (!isDue(now, s.allowanceDueDay)) continue;
    try {
      const run = await createRun(s.churchId, periodOf(now), { now });
      if (run) { await announceRun(s.churchId, run); drafted.push(s.churchId); }
    } catch (e) {
      console.error(`[allowances] run failed for church ${s.churchId}:`, e.message);
    }
  }
  return drafted;
}

/** Scheduler entry point: remind approvers once about allowances still unpaid five days after the run. */
async function sendAllowanceReminders(now = new Date()) {
  const runs = await rawDb.allowanceRun.findMany({
    where: { remindedAt: null, createdAt: { lte: new Date(now.getTime() - REMIND_AFTER_DAYS * DAY_MS) }, church: { deletedAt: null, suspendedAt: null } },
  });
  const reminded = [];
  for (const run of runs) {
    const claimed = await rawDb.allowanceRun.updateMany({ where: { id: run.id, remindedAt: null }, data: { remindedAt: now } });
    if (claimed.count !== 1) continue; // another machine has it
    const waiting = await rawDb.expense.aggregate({ where: { churchId: run.churchId, allowanceRunId: run.id, approvalStatus: 'SUBMITTED' }, _count: true, _sum: { amount: true } });
    if (!waiting._count) continue;
    const label = periodLabel(run.period);
    try {
      await alertApprovers(run.churchId, {
        title: `Reminder: ${label} allowances not yet paid`,
        text: `Reminder: ${plural(waiting._count, 'allowance', 'allowances')} for ${label} (${fmtMoney(waiting._sum.amount)}) ${waiting._count === 1 ? 'is' : 'are'} still waiting for approval.`,
        url: '/finance/allowances',
      });
      reminded.push(run.id);
    } catch (e) {
      console.error(`[allowances] reminder failed for run ${run.id}:`, e.message);
    }
  }
  return reminded;
}

module.exports = {
  periodOf, periodLabel, dueDateFor, isDue, createRun, announceRun, alertUsers, alertApprovers, alertRecipients, smsNumbers,
  runDueAllowances, sendAllowanceReminders,
};
