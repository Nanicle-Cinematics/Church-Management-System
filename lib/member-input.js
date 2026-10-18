'use strict';
// Shared member input handling for the JSON and HTML routes.
//
// Enum columns (gender, marital status, preferred channel) and date columns
// used to be passed to Prisma as-is, so any value outside the enum, or an
// unparseable date, surfaced as a 500. They are now validated up front.
// Member IDs ("MBR-001") were also allocated as max+1 with no lock; two
// concurrent creates picked the same number and the loser failed on the
// (churchId, externalId) unique index.

const crypto = require('crypto');

const GENDERS = ['M', 'F', 'O'];
const MARITAL_STATUSES = ['SINGLE', 'MARRIED', 'DIVORCED', 'WIDOWED', 'SEPARATED', 'OTHER'];
const PREFERRED_CHANNELS = ['EITHER', 'SMS_ONLY', 'EMAIL_ONLY', 'NONE'];
const DATE_FIELDS = [['dateOfBirth', 'Date of birth'], ['joinDate', 'Join date'], ['baptismDate', 'Baptism date'], ['confirmationDate', 'Confirmation date']];

const pickEnum = (value, allowed, fallback = null) => (allowed.includes(value) ? value : fallback);

function cleanDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** First problem with the enum/date fields, or null. */
function memberFieldError(b) {
  for (const [key, label] of DATE_FIELDS) {
    if (b[key] && !cleanDate(b[key])) return `${label} is not a valid date.`;
  }
  if (b.gender && !GENDERS.includes(b.gender)) return 'Gender must be M, F or O.';
  if (b.maritalStatus && !MARITAL_STATUSES.includes(b.maritalStatus)) return 'Marital status is not valid.';
  if (b.preferredChannel && !PREFERRED_CHANNELS.includes(b.preferredChannel)) return 'Communication preference is not valid.';
  return null;
}

// The church's own prefix (Finance settings, default MBR). Numbering continues
// per prefix, so changing it starts that prefix at 001 and leaves old IDs alone.
async function nextMemberId(db) {
  const settings = await db.financeSetting.findFirst();
  const prefix = (settings && settings.memberPrefix) || 'MBR';
  const rows = await db.member.findMany({ where: { externalId: { startsWith: `${prefix}-` } }, select: { externalId: true } });
  let max = 0;
  for (const r of rows) {
    const m = /-(\d+)$/.exec(r.externalId || '');
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${prefix}-${String(max + 1).padStart(3, '0')}`;
}

/** Create a member with the next free <prefix>-### id, retrying if another request took it. */
async function createMemberWithId(db, data) {
  for (let attempt = 0; ; attempt++) {
    const externalId = await nextMemberId(db);
    try {
      const member = await db.member.create({
        data: { ...data, externalId, unsubscribeToken: crypto.randomBytes(16).toString('hex') },
      });
      return member;
    } catch (e) {
      const target = String((e.meta && e.meta.target) || '');
      if (e.code === 'P2002' && /external_id|externalId/.test(target) && attempt < 5) continue;
      throw e;
    }
  }
}

module.exports = { pickEnum, cleanDate, memberFieldError, createMemberWithId, nextMemberId, GENDERS, MARITAL_STATUSES, PREFERRED_CHANNELS };
