'use strict';
// The one rule for a password someone chooses (sign-up, reset, a new teammate,
// an admin resetting a teammate). Length first, then the cheap checks that
// catch what people actually pick: the well-known passwords, a common word
// with digits or punctuation stuck on the end ("Welcome2024!"), one repeated
// character or all digits, and the person's own email name. Anything it
// accepts is hashed exactly as before; nothing here touches stored passwords.

const MIN_LENGTH = 10;

// Compared after the trailing digits and punctuation are stripped, so
// "password123", "Password1!" and "password2024" all reduce to "password".
const COMMON_BASES = new Set([
  'password', 'passw0rd', 'pass', 'qwerty', 'qwertyuiop', 'asdfghjkl', 'welcome', 'letmein', 'changeme',
  'admin', 'administrator', 'root', 'login', 'secret', 'default', 'master', 'test', 'demo', 'guest',
  'iloveyou', 'monkey', 'dragon', 'sunshine', 'football', 'abc', 'abcdef', 'abcdefghij',
  'church', 'methodist', 'jesus', 'god', 'blessed', 'ghana', 'accra',
]);

/** A sentence describing what is wrong with the password, or null if it is fine. */
function passwordProblem(password, { email } = {}) {
  const pw = typeof password === 'string' ? password : '';
  if (pw.length < MIN_LENGTH) return `Password must be at least ${MIN_LENGTH} characters.`;
  const lower = pw.toLowerCase();
  const base = lower.replace(/[\d\W_]+$/, '');
  if (COMMON_BASES.has(base) || /^(.)\1+$/.test(pw) || /^\d+$/.test(pw)) {
    return 'That password is too easy to guess. Choose something longer that is not a common word.';
  }
  const name = String(email || '').split('@')[0].toLowerCase();
  if (name.length >= 4 && lower.includes(name)) return 'Password must not contain your email name.';
  return null;
}

module.exports = { passwordProblem, MIN_PASSWORD_LENGTH: MIN_LENGTH };
