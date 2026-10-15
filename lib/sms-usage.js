'use strict';
// Texts each church sends per calendar month (UTC), and its monthly
// allowance: its plan's (lib/plan.js smsPerMonth) unless the platform
// operator set another for it (churches.sms_monthly_allowance).
//
// lib/delivery.js sendSmsBatch checks the allowance before a church's send
// and counts what was sent afterwards. A send that would go over is refused
// whole, never half-sent. Messages the platform itself sends a church (Pro
// renewal reminders) are neither counted nor limited.

const { db } = require('./tenant');
const { isPro, PLAN_LIMITS } = require('./plan');

const monthOf = (d = new Date()) => new Date(d).toISOString().slice(0, 7);

// GSM-7 texts take 160 characters (153 per page once split); anything else,
// e.g. emoji or Ghanaian characters like ɛ and ɔ, takes 70 (67).
const GSM7 = /^[A-Za-z0-9 \r\n@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà^{}\\[~\]|€]*$/;
function smsSegments(message) {
  const text = String(message || '');
  if (!text) return 1;
  if (GSM7.test(text)) {
    const len = text.length + (text.match(/[\^{}\\[~\]|€]/g) || []).length; // these count twice
    return len <= 160 ? 1 : Math.ceil(len / 153);
  }
  const len = [...text].length;
  return len <= 70 ? 1 : Math.ceil(len / 67);
}

function allowanceFor(church) {
  if (church && Number.isInteger(church.smsMonthlyAllowance) && church.smsMonthlyAllowance >= 0) return church.smsMonthlyAllowance;
  return PLAN_LIMITS[isPro(church) ? 'pro' : 'free'].smsPerMonth;
}

async function usageFor(churchId, month = monthOf()) {
  const row = await db.smsUsage.findUnique({ where: { churchId_month: { churchId, month } } });
  return row ? { messages: row.messages, segments: row.segments } : { messages: 0, segments: 0 };
}

/** Whether a church may send `count` more texts this month. */
async function allowanceCheck(churchId, count, now = new Date()) {
  const church = await db.church.findUnique({ where: { id: churchId }, select: { plan: true, proUntil: true, smsMonthlyAllowance: true } });
  const allowance = allowanceFor(church);
  const { messages: used } = await usageFor(churchId, monthOf(now));
  const remaining = Math.max(0, allowance - used);
  return { ok: count <= remaining, used, allowance, remaining };
}

async function recordUsage(churchId, recipients, message, now = new Date()) {
  const month = monthOf(now);
  const segments = recipients * smsSegments(message);
  await db.smsUsage.upsert({
    where: { churchId_month: { churchId, month } },
    create: { churchId, month, messages: recipients, segments },
    update: { messages: { increment: recipients }, segments: { increment: segments } },
  });
}

/** For the operator: every church's use in a month, with its allowance. */
async function usageReport(month = monthOf()) {
  const [rows, churches] = await Promise.all([
    db.smsUsage.findMany({ where: { month } }),
    db.church.findMany({ where: { deletedAt: null }, select: { id: true, name: true, slug: true, plan: true, proUntil: true, smsMonthlyAllowance: true } }),
  ]);
  const used = new Map(rows.map((r) => [r.churchId, r]));
  return churches.map((c) => {
    const u = used.get(c.id);
    const allowance = allowanceFor(c);
    return { ...c, messages: u ? u.messages : 0, segments: u ? u.segments : 0, allowance, custom: c.smsMonthlyAllowance !== null && c.smsMonthlyAllowance !== undefined };
  }).sort((a, b) => b.messages - a.messages || a.name.localeCompare(b.name));
}

module.exports = { smsSegments, allowanceFor, usageFor, allowanceCheck, recordUsage, usageReport, monthOf };
