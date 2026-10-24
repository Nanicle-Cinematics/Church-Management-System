'use strict';
// The preaching plan's preachers are appointed by code, as on the Methodist plan:
// S superintendent minister, M1 circuit minister, M2 society minister, and
// numbers for circuit lay preachers.

const TYPES = { S: 'Superintendent Minister', M1: 'Circuit Minister', M2: 'Society Minister' };

/** " m1 " to "M1", "07" to "7"; null when it is not S, M1, M2 or a number up to 999. */
function parseCode(input) {
  const t = String(input == null ? '' : input).trim().toUpperCase().replace(/\s+/g, '');
  if (t === 'S' || t === 'M1' || t === 'M2') return t;
  return /^\d{1,3}$/.test(t) && Number(t) >= 1 ? String(Number(t)) : null;
}

const typeOf = (code) => TYPES[code] || 'Circuit Lay Preacher';

/** S, M1, M2, then lay preachers by number. */
const byCode = (a, b) => {
  const rank = (c) => (c === 'S' ? 0 : c === 'M1' ? 1 : c === 'M2' ? 2 : 3);
  return rank(a.code) - rank(b.code) || Number(a.code) - Number(b.code);
};

/**
 * What to store on a preaching plan row for a roster preacher, so reminders work as
 * they always have: a preacher who is a member is reached through the member record,
 * any other through the name and contact copied here.
 */
function planFields(p) {
  return p.memberId
    ? { preacherId: p.id, memberId: p.memberId, preacherName: null, preacherPhone: null, preacherEmail: null }
    : { preacherId: p.id, memberId: null, preacherName: p.name, preacherPhone: p.phone || null, preacherEmail: p.email || null };
}

/** "M1 · Rev. Kofi Mensah" for lists; falls back to the member or guest on older rows. */
function planPreacherText(plan) {
  if (plan.preacher) return `${plan.preacher.code} · ${plan.preacher.name}`;
  if (plan.member) return `${plan.member.firstName} ${plan.member.lastName}`;
  return plan.preacherName || '';
}

module.exports = { TYPES, parseCode, typeOf, byCode, planFields, planPreacherText };
