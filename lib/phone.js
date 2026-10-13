'use strict';
// Phone numbers used to sign in. Stored in one form, +<country code><number>,
// so "024 412 7781", "0244127781" and "+233 24 412 7781" are the same login.
// Local numbers (a leading 0) take DEFAULT_PHONE_COUNTRY_CODE (Ghana, 233).

const DEFAULT_COUNTRY = String(process.env.DEFAULT_PHONE_COUNTRY_CODE || '233').replace(/\D/g, '');

/** The stored form of a phone number, or null if it does not look like one. */
function normalizePhone(input) {
  const raw = String(input || '').trim();
  if (!raw || /[a-z@]/i.test(raw)) return null;
  let digits = raw.replace(/[\s().-]/g, '');
  if (!/^\+?\d+$/.test(digits)) return null;
  if (digits.startsWith('+')) digits = digits.slice(1);
  else if (digits.startsWith('00')) digits = digits.slice(2);
  else if (digits.startsWith('0')) digits = DEFAULT_COUNTRY + digits.slice(1);
  if (digits.length < 9 || digits.length > 15) return null;
  return `+${digits}`;
}

/** Is this sign-in identifier an email (as opposed to a phone number)? */
const looksLikeEmail = (value) => String(value || '').includes('@');

/** What to call a user in logs and lists: their email, else phone, else username. */
const loginLabel = (user) => (user && (user.email || user.phone || user.username)) || '';

module.exports = { normalizePhone, looksLikeEmail, loginLabel };
