'use strict';
// Members > Import: read a CSV or Excel file (.csv, .xlsx, .xls, .ods),
// guess which column is which, turn each row into a member, and spot rows
// that are already in the church. Pure functions apart from findExisting();
// routes-pg-html/member-import.js does the HTTP side.

const XLSX = require('xlsx');
const { GENDERS } = require('./member-input');

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 5000;
const MAX_COLS = 60;
const MAX_CELL = 500;
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const STATUSES = ['VISITOR', 'REGULAR', 'MEMBER', 'INACTIVE', 'TRANSFERRED', 'DECEASED', 'OTHER'];
const CHANNELS = ['EITHER', 'SMS_ONLY', 'EMAIL_ONLY', 'NONE'];

// Where a column can go, with the header words that suggest it.
const FIELDS = [
  ['externalId', 'Member ID', ['member id', 'member no', 'member number', 'membership no', 'membership number', 'id', 'no', 'reg no']],
  ['fullName', 'Full name', ['name', 'full name', 'fullname', 'member name', 'names']],
  ['firstName', 'First name', ['first name', 'firstname', 'given name', 'forename', 'other names', 'first']],
  ['lastName', 'Last name', ['last name', 'lastname', 'surname', 'family name', 'last']],
  ['preferredName', 'Preferred name', ['preferred name', 'known as', 'nickname', 'alias']],
  ['gender', 'Gender', ['gender', 'sex']],
  ['dateOfBirth', 'Date of birth', ['date of birth', 'dob', 'birth date', 'birthday', 'birthdate', 'd.o.b']],
  ['dayBorn', 'Day born', ['day born', 'dayborn', 'day of birth', 'akan day']],
  ['mobilePhone', 'Mobile phone', ['mobile', 'phone', 'mobile phone', 'phone number', 'telephone', 'tel', 'contact', 'mobile number', 'cell', 'whatsapp']],
  ['email', 'Email', ['email', 'e-mail', 'email address', 'mail']],
  ['maritalStatus', 'Marital status', ['marital status', 'marital', 'married']],
  ['membershipStatus', 'Status', ['status', 'membership status', 'membership', 'member status', 'type']],
  ['joinDate', 'Join date', ['joined', 'join date', 'date joined', 'membership date', 'date of joining']],
  ['baptismDate', 'Baptism date', ['baptism date', 'baptised', 'baptized', 'date of baptism', 'baptism']],
  ['baptismLocation', 'Baptism place', ['baptism place', 'baptism location', 'place of baptism']],
  ['confirmationDate', 'Confirmation date', ['confirmation date', 'confirmed', 'date of confirmation', 'confirmation']],
  ['bibleClass', 'Bible class', ['bible class', 'class', 'class leader', 'bibleclass', 'fellowship']],
  ['organizations', 'Organisations', ['organisations', 'organizations', 'organisation', 'organization', 'groups', 'group', 'societies', 'society']],
  ['preferredChannel', 'Contact preference', ['preferred channel', 'contact preference', 'channel']],
  ['emergencyContactName', 'Emergency contact', ['emergency contact', 'emergency contact name', 'next of kin', 'nok']],
  ['emergencyContactPhone', 'Emergency contact phone', ['emergency phone', 'emergency contact phone', 'next of kin phone', 'nok phone']],
  ['emergencyContactRelation', 'Emergency contact relation', ['relationship', 'emergency contact relation', 'relation']],
  ['notes', 'Notes', ['notes', 'note', 'remarks', 'comment', 'comments', 'occupation', 'address']],
];
const FIELD_KEYS = FIELDS.map((f) => f[0]);
const norm = (s) => String(s || '').toLowerCase().replace(/[_\-.:#()/]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Guess a field for each header; each field is used at most once. Returns an array of field keys or ''. */
function guessMapping(headers) {
  const used = new Set();
  const out = headers.map(() => '');
  // Exact matches first, then "header contains alias", so "Phone" beats "Emergency phone".
  for (const pass of ['exact', 'contains']) {
    headers.forEach((h, i) => {
      if (out[i]) return;
      const n = norm(h);
      if (!n) return;
      for (const [key, , aliases] of FIELDS) {
        if (used.has(key)) continue;
        const names = aliases.map(norm);
        const hit = pass === 'exact' ? names.includes(n) || norm(key) === n : names.some((a) => a.length > 3 && n.includes(a));
        if (hit) { out[i] = key; used.add(key); return; }
      }
    });
  }
  // A "Name" column alongside first/last name columns is not a full name.
  if (out.includes('fullName') && (out.includes('firstName') || out.includes('lastName'))) out[out.indexOf('fullName')] = '';
  return out;
}

const cellText = (v) => {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
  if (v === null || v === undefined) return '';
  return String(v).replace(/\s+/g, ' ').trim().slice(0, MAX_CELL);
};

/**
 * Read the first sheet of an uploaded file. Returns { headers, rows } where
 * rows are arrays of trimmed strings (dates as YYYY-MM-DD), or { error }.
 * CSV is read as plain text so day-first dates like 12/03/1990 are not
 * reinterpreted as US dates.
 */
function readSheet(buffer, fileName) {
  if (!buffer || !buffer.length) return { error: 'The file is empty.' };
  if (buffer.length > MAX_FILE_BYTES) return { error: 'The file is larger than 5 MB. Split it into smaller files.' };
  const ext = String(fileName || '').toLowerCase().split('.').pop();
  if (!['csv', 'txt', 'xlsx', 'xls', 'ods'].includes(ext)) return { error: 'Upload a .csv, .xlsx or .xls file.' };
  let wb;
  try {
    wb = XLSX.read(buffer, {
      type: 'buffer', cellDates: true, UTC: true, dense: true, sheetRows: MAX_ROWS + 20,
      cellFormula: false, cellHTML: false, cellStyles: false, bookVBA: false,
      ...(ext === 'csv' || ext === 'txt' ? { raw: true, codepage: 65001 } : {}),
    });
  } catch (_) {
    return { error: 'That file could not be read. Save it as .xlsx or .csv and try again.' };
  }
  const sheet = wb.SheetNames.length ? wb.Sheets[wb.SheetNames[0]] : null;
  if (!sheet) return { error: 'The file has no sheets.' };
  const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '', blankrows: false, UTC: true })
    .map((r) => r.slice(0, MAX_COLS).map(cellText))
    .filter((r) => r.some((c) => c));
  if (grid.length < 2) return { error: 'The file needs a header row and at least one member.' };
  const headers = grid[0].map((h, i) => h || `Column ${i + 1}`);
  const rows = grid.slice(1).map((r) => headers.map((_, i) => r[i] || ''));
  if (rows.length > MAX_ROWS) return { error: `The file has more than ${MAX_ROWS} rows. Split it into smaller files.` };
  return { headers, rows };
}

// ---- value cleaning ----
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function ymd(y, m, d) {
  if (y < 100) y += y > (new Date().getUTCFullYear() % 100) ? 1900 : 2000;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  if (y < 1880 || dt.getTime() > Date.now() + 366 * 86400000) return null;
  return dt.toISOString().slice(0, 10);
}
/** A date in any common form, read day-first (as in Ghana). Returns YYYY-MM-DD or null. */
function parseDate(s) {
  s = String(s || '').trim();
  if (!s) return null;
  let m;
  if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T].*)?$/.exec(s))) return ymd(+m[1], +m[2], +m[3]);
  if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(s))) return ymd(+m[3], +m[2], +m[1]);
  if ((m = /^(\d{1,2})(?:st|nd|rd|th)?[\s\-/.]+([a-z]+)\.?,?[\s\-/.]+(\d{2}|\d{4})$/i.exec(s))) {
    const mi = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
    return mi >= 0 ? ymd(+m[3], mi + 1, +m[1]) : null;
  }
  if ((m = /^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/i.exec(s))) {
    const mi = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    return mi >= 0 ? ymd(+m[3], mi + 1, +m[2]) : null;
  }
  if (/^\d{4,5}(\.\d+)?$/.test(s)) { // an Excel date serial number left as a number
    const c = XLSX.SSF.parse_date_code(Number(s));
    return c ? ymd(c.y, c.m, c.d) : null;
  }
  return null;
}

function parseGender(s) {
  const n = norm(s);
  if (!n) return null;
  if (['m', 'male', 'man', 'boy', 'mr'].includes(n)) return 'M';
  if (['f', 'female', 'woman', 'girl', 'mrs', 'ms', 'miss'].includes(n)) return 'F';
  if (GENDERS.includes(n.toUpperCase())) return n.toUpperCase();
  return undefined;
}
function parseMarital(s) {
  const n = norm(s);
  if (!n) return null;
  const map = { single: 'SINGLE', unmarried: 'SINGLE', married: 'MARRIED', divorced: 'DIVORCED', widowed: 'WIDOWED', widow: 'WIDOWED', widower: 'WIDOWED', separated: 'SEPARATED', other: 'OTHER' };
  return map[n] || undefined;
}
function parseStatus(s) {
  const n = norm(s);
  if (!n) return null;
  if (STATUSES.includes(n.toUpperCase())) return n.toUpperCase();
  const map = { 'full member': 'MEMBER', active: 'MEMBER', communicant: 'MEMBER', adherent: 'REGULAR', 'not active': 'INACTIVE', dead: 'DECEASED', late: 'DECEASED', transfer: 'TRANSFERRED', 'transferred out': 'TRANSFERRED', guest: 'VISITOR', new: 'VISITOR' };
  return map[n] || undefined;
}
function parseChannel(s) {
  const n = norm(s);
  if (!n) return null;
  const map = { both: 'EITHER', either: 'EITHER', any: 'EITHER', sms: 'SMS_ONLY', 'sms only': 'SMS_ONLY', text: 'SMS_ONLY', email: 'EMAIL_ONLY', 'email only': 'EMAIL_ONLY', none: 'NONE', 'do not contact': 'NONE', no: 'NONE' };
  if (CHANNELS.includes(n.toUpperCase().replace(/ /g, '_'))) return n.toUpperCase().replace(/ /g, '_');
  return map[n] || undefined;
}
function parseDay(s) {
  const n = norm(s);
  if (!n) return null;
  return DAYS.find((d) => d.toLowerCase() === n || d.slice(0, 3).toLowerCase() === n) || undefined;
}
const TITLES = /^(mr|mrs|ms|miss|madam|mad|rev|revd|very rev|rt rev|dr|prof|bro|sis|brother|sister|elder|deacon|deaconess|pastor|catechist|hon|nana|togbe|lay preacher)\.?\s+/i;
function splitName(full) {
  let s = String(full || '').trim();
  while (TITLES.test(s)) s = s.replace(TITLES, '');
  if (s.includes(',')) {
    const [last, first] = s.split(',', 2).map((x) => x.trim());
    return { firstName: first, lastName: last };
  }
  const parts = s.split(/\s+/).filter(Boolean);
  return { firstName: parts[0] || '', lastName: parts.slice(1).join(' ') };
}
const titleCase = (s) => (s && s === s.toUpperCase() && /[A-Z]{2}/.test(s)
  ? s.toLowerCase().replace(/(^|[\s\-'])([a-z])/g, (_, a, b) => a + b.toUpperCase()) : s);

/**
 * Turn one row into member data using the column mapping.
 * opts: { defaultStatus, defaultChannel }. Returns { data, names, problems, error }:
 * `error` means the row cannot be imported; `problems` are values left out.
 */
function rowToMember(row, mapping, opts = {}) {
  const v = {};
  mapping.forEach((key, i) => { if (key && row[i] && !v[key]) v[key] = row[i]; });
  const problems = [];
  let { firstName = '', lastName = '' } = v;
  if (v.fullName && !firstName && !lastName) ({ firstName, lastName } = splitName(v.fullName));
  firstName = titleCase(String(firstName).trim()).slice(0, 80);
  lastName = titleCase(String(lastName).trim()).slice(0, 80);
  if (!firstName || !lastName) return { error: firstName || lastName ? 'Needs both a first and a last name.' : 'No name.' };

  const pick = (key, parse, label) => {
    if (!v[key]) return null;
    const out = parse(v[key]);
    if (out === undefined || (out === null && v[key])) { problems.push(`${label} "${v[key]}" not understood`); return null; }
    return out;
  };
  const email = v.email ? String(v.email).toLowerCase().trim() : '';
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) problems.push(`email "${v.email}" not valid`);
  const phone = v.mobilePhone ? String(v.mobilePhone).replace(/[^\d+]/g, '') : '';
  if (v.mobilePhone && phone.replace(/\D/g, '').length < 7) problems.push(`phone "${v.mobilePhone}" too short`);
  const data = {
    externalId: v.externalId ? String(v.externalId).trim().slice(0, 40) : null,
    firstName, lastName,
    preferredName: v.preferredName || null,
    gender: pick('gender', parseGender, 'Gender'),
    dateOfBirth: pick('dateOfBirth', parseDate, 'Date of birth'),
    dayBorn: pick('dayBorn', parseDay, 'Day born'),
    email: email && !problems.some((p) => p.startsWith('email')) ? email : null,
    mobilePhone: phone && !problems.some((p) => p.startsWith('phone')) ? (v.mobilePhone.trim().startsWith('+') ? `+${phone.replace(/\+/g, '')}` : phone.replace(/\+/g, '')) : null,
    maritalStatus: pick('maritalStatus', parseMarital, 'Marital status'),
    membershipStatus: pick('membershipStatus', parseStatus, 'Status') || opts.defaultStatus || 'MEMBER',
    joinDate: pick('joinDate', parseDate, 'Join date'),
    baptismDate: pick('baptismDate', parseDate, 'Baptism date'),
    baptismLocation: v.baptismLocation || null,
    confirmationDate: pick('confirmationDate', parseDate, 'Confirmation date'),
    preferredChannel: pick('preferredChannel', parseChannel, 'Contact preference') || opts.defaultChannel || 'EITHER',
    emergencyContactName: v.emergencyContactName || null,
    emergencyContactPhone: v.emergencyContactPhone || null,
    emergencyContactRelation: v.emergencyContactRelation || null,
    notes: v.notes || null,
  };
  if (!data.dayBorn && data.dateOfBirth) data.dayBorn = DAYS[new Date(`${data.dateOfBirth}T00:00:00Z`).getUTCDay()];
  const names = {
    bibleClass: v.bibleClass ? String(v.bibleClass).trim().slice(0, 120) : '',
    organizations: v.organizations ? String(v.organizations).split(/[;,|]/).map((x) => x.trim().slice(0, 120)).filter(Boolean) : [],
  };
  return { data, names, problems };
}

const phoneKey = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length >= 9 ? d.slice(-9) : ''; };
const nameKey = (m) => `${norm(m.firstName)}|${norm(m.lastName)}|${m.dateOfBirth ? String(m.dateOfBirth instanceof Date ? m.dateOfBirth.toISOString() : m.dateOfBirth).slice(0, 10) : ''}`;

/** Keys of the church's current members, to spot rows already in it. `db` is church-scoped. */
async function existingKeys(db) {
  const members = await db.member.findMany({ where: { deletedAt: null }, select: { firstName: true, lastName: true, dateOfBirth: true, mobilePhone: true, email: true } });
  const keys = { phone: new Set(), email: new Set(), name: new Set() };
  for (const m of members) addKeys(keys, m);
  return keys;
}
function addKeys(keys, m) {
  const p = phoneKey(m.mobilePhone);
  if (p) keys.phone.add(p);
  if (m.email) keys.email.add(String(m.email).toLowerCase());
  keys.name.add(nameKey(m));
}
/** Why this member matches one in `keys` (the church's members, or earlier rows), or null. */
function duplicateReason(keys, data) {
  const p = phoneKey(data.mobilePhone);
  if (p && keys.phone.has(p)) return 'same phone number';
  if (data.email && keys.email.has(data.email)) return 'same email';
  if (keys.name.has(nameKey(data))) return data.dateOfBirth ? 'same name and date of birth' : 'same name';
  return null;
}

module.exports = {
  FIELDS, FIELD_KEYS, MAX_ROWS, MAX_FILE_BYTES, STATUSES, CHANNELS,
  readSheet, guessMapping, parseDate, rowToMember, splitName, existingKeys, addKeys, duplicateReason,
};
