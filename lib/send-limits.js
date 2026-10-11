'use strict';
// Outbound SMS/email goes through ONE shared SMTP and Arkesel account for every
// church, so a church's sending is the platform's cost and reputation. Without
// a ceiling, any free signup could broadcast to unlimited addresses.
//
// Counted from BroadcastRecipient rows (everything not SKIPPED) in a rolling
// 24 hours. Tunable per deployment:
//   BROADCAST_DAILY_LIMIT_FREE (default 200), BROADCAST_DAILY_LIMIT_PRO (default 5000)

const { isPro } = require('./plan');

const MAX_BODY_LENGTH = 900;
const MAX_SUBJECT_LENGTH = 200;

function dailyLimit(church) {
  const free = Number(process.env.BROADCAST_DAILY_LIMIT_FREE) || 200;
  const pro = Number(process.env.BROADCAST_DAILY_LIMIT_PRO) || 5000;
  return isPro(church) ? pro : free;
}

/**
 * { ok, used, limit, needed }. `needed` is an upper bound: every audience
 * member on every selected channel, before preferences filter anyone out.
 */
async function checkBroadcastAllowance(db, church, audienceSize, channel) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const used = await db.broadcastRecipient.count({ where: { status: { not: 'SKIPPED' }, broadcast: { sentAt: { gte: since } } } });
  const limit = dailyLimit(church);
  const needed = audienceSize * (channel === 'both' ? 2 : 1);
  return { ok: used + needed <= limit, used, limit, needed };
}

function allowanceMessage(a) {
  const left = Math.max(0, a.limit - a.used);
  return `Daily sending limit reached: this would send up to ${a.needed} messages, but only ${left} of today's ${a.limit} remain. Try a smaller audience or wait until tomorrow.`;
}

function validateBroadcastText(subject, body) {
  if (String(body || '').length > MAX_BODY_LENGTH) return `Message is too long (maximum ${MAX_BODY_LENGTH} characters).`;
  if (String(subject || '').length > MAX_SUBJECT_LENGTH) return `Subject is too long (maximum ${MAX_SUBJECT_LENGTH} characters).`;
  return null;
}

module.exports = { checkBroadcastAllowance, allowanceMessage, validateBroadcastText, dailyLimit, MAX_BODY_LENGTH };
