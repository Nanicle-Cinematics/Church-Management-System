'use strict';
// Pure formatting, validation and byte-inspection helpers. No app/db state.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS_OF_WEEK = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const fmtMoney = (n) => {
  if (n == null) return '';
  const v = Number(n);
  return 'GH₵ ' + v.toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const fmtOutstanding = (n) => Number(n) > 0 ? `<span class="negative">${fmtMoney(n)}</span>` : fmtMoney(n);
const fmtDate = (s) => (s ? String(s).slice(0, 10) : '');
const todayISO = () => new Date().toISOString().slice(0, 10);

const initials = (name) => {
  if (!name) return '?';
  return name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
};

// DOB is stored as YYYY-MM-DD. A birthday entered without a year (the member
// form asks for day and month only) gets the sentinel year 1900, or 1904 for
// 29 February, which 1900 lacks. Any year before 1905 therefore means "no
// year": not shown, and no age worked out from it.
const NO_YEAR_BEFORE = 1905;
const dobMonth = (s) => (s ? Number(String(s instanceof Date ? s.toISOString() : s).slice(5, 7)) : 0);
const dobDay = (s) => (s ? Number(String(s instanceof Date ? s.toISOString() : s).slice(8, 10)) : 0);
const dobYear = (s) => (s ? Number(String(s instanceof Date ? s.toISOString() : s).slice(0, 4)) : 0);
const dobHasYear = (s) => dobYear(s) >= NO_YEAR_BEFORE;
const fmtDobShort = (s) => {
  const m = dobMonth(s), d = dobDay(s);
  return (m && d) ? `${MONTHS[m - 1]} ${d}` : '';
};
/** "14 March", or "14 March 1990" when the year is known. */
const fmtBirthday = (s) => {
  const m = dobMonth(s), d = dobDay(s);
  if (!m || !d) return '';
  return `${d} ${MONTHS[m - 1]}${dobHasYear(s) ? ` ${dobYear(s)}` : ''}`;
};
/** YYYY-MM-DD for a day and month, keeping `year` when it is a real one; null if no such date. */
function birthDate(month, day, year) {
  const mm = Number(month), dd = Number(day), yy = Number(year);
  if (!Number.isInteger(mm) || !Number.isInteger(dd) || mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const valid = (y) => { const t = new Date(Date.UTC(y, mm - 1, dd)); return t.getUTCMonth() === mm - 1 && t.getUTCDate() === dd; };
  let y = Number.isInteger(yy) && yy >= NO_YEAR_BEFORE && valid(yy) ? yy : 1900;
  if (!valid(y)) y = 1904; // 29 February
  if (!valid(y)) return null; // e.g. 31 April
  return `${y}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}
const parseDob = (m, d) => birthDate(m, d);
const fmtPreachDate = (s) => {
  if (!s) return '';
  const d = new Date(String(s).slice(0, 10) + 'T00:00:00');
  return isNaN(d) ? String(s)
    : d.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
};

// Validation
const isValidDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const isMoneyNonNeg = (s) => { const n = Number(s); return Number.isFinite(n) && n >= 0; };
const isMoneyPositive = (s) => { const n = Number(s); return Number.isFinite(n) && n > 0; };
const isEmailish = (s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s));
const isPhoneish = (s) => String(s).replace(/\D/g, '').length >= 7;

// Bytes / uploads
function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function isSqliteBuffer(buf) {
  return buf && buf.length >= 16 && buf.toString('latin1', 0, 15) === 'SQLite format 3';
}
function looksLikeImage(buf) {
  if (!buf || buf.length < 12) return false;
  const jpg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const png = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const gif = buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38;
  const webp = buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
  return jpg || png || gif || webp;
}

module.exports = {
  MONTHS, DAYS_OF_WEEK,
  esc, fmtMoney, fmtOutstanding, fmtDate, todayISO, initials,
  dobMonth, dobDay, dobYear, dobHasYear, fmtDobShort, fmtBirthday, birthDate, parseDob, fmtPreachDate,
  isValidDate, isMoneyNonNeg, isMoneyPositive, isEmailish, isPhoneish,
  fmtBytes, isSqliteBuffer, looksLikeImage,
};
