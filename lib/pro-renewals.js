'use strict';
// Pro renewals: which churches' Pro plans end soon or have just ended
// (Platform › Pro renewals), and reminders to each church's admins by email
// and text, 14 days and 3 days before the end and once on the day it lapses.
// A lapsed plan already falls back to Free on its own (lib/plan.js isPro).
//
// Each reminder is sent once per end date: churches.pro_reminder_stage and
// pro_reminder_for record the last one and the end date it was about, so
// extending a plan starts its reminders afresh. A reminder is claimed with a
// conditional update before it is sent, so two app machines never both send it.

const { db: rawDb, tenantDb } = require('./tenant');
const { sendEmailEach, sendSmsBatch, normalizePhoneGH } = require('./delivery');

const DAY_MS = 24 * 60 * 60 * 1000;
const STAGES = ['14d', '3d', 'lapsed'];
const rank = (stage) => (stage ? STAGES.indexOf(stage) : -1);

/** The reminder due for a plan ending at `until`, or null. */
function dueStage(until, now = new Date()) {
  const daysLeft = (new Date(until) - now) / DAY_MS;
  if (daysLeft <= 0) return daysLeft > -7 ? 'lapsed' : null; // a week late is too late to say "today"
  if (daysLeft <= 3) return '3d';
  if (daysLeft <= 14) return '14d';
  return null;
}

const fmtDay = (d) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

// How to renew, e.g. BILLING_CONTACT="Call or WhatsApp 024 412 7781". Not
// "reply": texts come from a sender name, which cannot receive replies.
function renewalContact() {
  return process.env.BILLING_CONTACT || 'Contact Church Manager support';
}

function reminderText(church, stage) {
  const end = fmtDay(church.proUntil);
  if (stage === 'lapsed') {
    return `${church.name}'s Church Manager Pro plan ended on ${end}. Your church is now on the Free plan: everything is kept, but Pro features such as reports are paused. ${renewalContact()} to renew.`;
  }
  return `${church.name}'s Church Manager Pro plan ends on ${end}. ${renewalContact()} to renew and keep reports and unlimited users.`;
}

/** Send the reminders that are due. Returns the churches reminded, with the stage. */
async function sendProRenewalReminders(now = new Date()) {
  const churches = await rawDb.church.findMany({
    where: {
      plan: 'pro', deletedAt: null, suspendedAt: null,
      proUntil: { gt: new Date(now.getTime() - 7 * DAY_MS), lte: new Date(now.getTime() + 14 * DAY_MS) },
    },
    select: { id: true, name: true, proUntil: true, proReminderStage: true, proReminderFor: true },
  });
  const sent = [];
  for (const church of churches) {
    const stage = dueStage(church.proUntil, now);
    if (!stage) continue;
    const sameEnd = church.proReminderFor && +church.proReminderFor === +church.proUntil;
    const previous = sameEnd ? church.proReminderStage : null;
    if (rank(stage) <= rank(previous)) continue;
    // Claim it: only one machine wins the update.
    const claimed = await rawDb.church.updateMany({
      where: { id: church.id, proReminderStage: church.proReminderStage, proReminderFor: church.proReminderFor },
      data: { proReminderStage: stage, proReminderFor: church.proUntil },
    });
    if (!claimed.count) continue;
    try {
      await remindAdmins(church, stage);
    } catch (e) {
      console.error(`[pro-renewals] reminder for ${church.id} failed:`, e.message);
    }
    sent.push({ churchId: church.id, stage });
  }
  return sent;
}

async function remindAdmins(church, stage) {
  const admins = await rawDb.user.findMany({
    where: { churchId: church.id, role: 'ADMIN', deletedAt: null },
    select: { email: true, phone: true },
  });
  const text = reminderText(church, stage);
  const subject = stage === 'lapsed' ? 'Your Church Manager Pro plan has ended' : `Your Church Manager Pro plan ends on ${fmtDay(church.proUntil)}`;
  const emails = admins.filter((a) => a.email && a.email.includes('@')).map((a) => ({ addr: a.email }));
  if (emails.length) await sendEmailEach(tenantDb(church.id), emails, subject, text, { churchName: 'Church Manager', withFooter: false });
  const phones = [...new Set(admins.map((a) => normalizePhoneGH(a.phone)).filter(Boolean))];
  if (phones.length) await sendSmsBatch(phones, text.slice(0, 320), { churchId: church.id, platform: true });
}

/** For the portal: Pro plans ending within `aheadDays`, and those ended in the last `behindDays`. */
async function renewalsOverview(now = new Date(), { aheadDays = 30, behindDays = 60 } = {}) {
  const rows = await rawDb.church.findMany({
    where: {
      plan: 'pro', deletedAt: null,
      proUntil: { gt: new Date(now.getTime() - behindDays * DAY_MS), lte: new Date(now.getTime() + aheadDays * DAY_MS) },
    },
    orderBy: { proUntil: 'asc' },
    select: { id: true, name: true, slug: true, proUntil: true, proReminderStage: true, proReminderFor: true, suspendedAt: true },
  });
  return rows.map((c) => ({
    ...c,
    daysLeft: Math.ceil((new Date(c.proUntil) - now) / DAY_MS),
    lapsed: new Date(c.proUntil) <= now,
    lastReminder: c.proReminderFor && +c.proReminderFor === +c.proUntil ? c.proReminderStage : null,
  }));
}

/** The new end date when a plan is extended by `months`: from its current end if still running, else from now. */
function extendedUntil(proUntil, months, now = new Date()) {
  const from = proUntil && new Date(proUntil) > now ? new Date(proUntil) : now;
  return new Date(from.getTime() + months * 30 * DAY_MS);
}

module.exports = { sendProRenewalReminders, renewalsOverview, extendedUntil, dueStage, reminderText };
