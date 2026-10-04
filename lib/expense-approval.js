'use strict';
// Who may approve (and so pay) an expense, by amount. The limits live in
// FinanceSetting (smallExpenseMax / mediumExpenseMax):
//   amount <= small            any fund manager (Treasurer, Finance Admin, Admin)
//   small  < amount <= medium  Finance Admin or Admin
//   amount > medium            Admin only
// This sits on top of the maker-checker rule (nobody approves an expense they
// recorded), which is checked separately and is not relaxed by tier.
// Rejecting is not tiered: declining to pay can never move money.

const DEFAULT_LIMITS = { smallExpenseMax: 500, mediumExpenseMax: 5000 };
const TIER_LABELS = { 1: 'a fund manager', 2: 'a Finance Admin or Admin', 3: 'an Admin' };

/** 3 = Admin, 2 = Finance Admin, 1 = Treasurer, 0 = cannot approve. */
function approverTier(user) {
  if (!user) return 0;
  if (user.role === 'ADMIN') return 3;
  if (user.financeRole === 'FINANCE_ADMIN') return 2;
  if (user.financeRole === 'TREASURER') return 1;
  return 0;
}

function limitsFrom(settings) {
  // No FinanceSetting row (a church that never saved the settings page) must
  // mean the defaults, not zero: Number(null) is 0, which would make every
  // expense Admin-only.
  const pick = (value, fallback) => (value === null || value === undefined || !Number.isFinite(Number(value)) ? fallback : Number(value));
  return {
    small: pick(settings && settings.smallExpenseMax, DEFAULT_LIMITS.smallExpenseMax),
    medium: pick(settings && settings.mediumExpenseMax, DEFAULT_LIMITS.mediumExpenseMax),
  };
}

/** Lowest approver tier allowed to approve an expense of this amount. */
function requiredTier(amount, settings) {
  const { small, medium } = limitsFrom(settings);
  const a = Number(amount) || 0;
  if (a <= small) return 1;
  if (a <= medium) return 2;
  return 3;
}

/** { ok: true } or { ok: false, needs: 'an Admin' }. */
function checkApprovalTier(user, amount, settings) {
  const need = requiredTier(amount, settings);
  return approverTier(user) >= need ? { ok: true } : { ok: false, needs: TIER_LABELS[need] };
}

module.exports = { approverTier, requiredTier, checkApprovalTier, limitsFrom, TIER_LABELS, DEFAULT_LIMITS };
