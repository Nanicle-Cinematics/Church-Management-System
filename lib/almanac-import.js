'use strict';
// Platform > Almanac: read a spreadsheet (CSV or Excel) of the Almanac into entries.
// One row per service. The file layout is forgiving about column names (the Almanac
// is typed up in many ways) but strict about what each row must hold: a date, a
// name and a colour we know. Reuses the member import's reader, so the file limits
// and day-first dates (12/03/2026 is 12 March) behave the same way.

const imp = require('./member-import');
const { parseColour } = require('./liturgical');

// Columns as printed in the Methodist Church Ghana Lectionary: Month, Date, Name, Colour, Theme,
// Old Testament, Psalms, New Testament/Epistle, Gospel, and "MHB & CAN" (the hymn
// numbers for the service).
const FIELDS = [
  ['month', 'Month', ['month']],
  ['serviceDate', 'Date', ['date', 'servicedate', 'sundaydate', 'day']],
  ['title', 'Name', ['name', 'title', 'sundayname', 'liturgicalday', 'sunday', 'description']],
  ['colour', 'Colour', ['colour', 'color', 'liturgicalcolour', 'liturgicalcolor']],
  ['theme', 'Theme', ['theme']],
  ['oldTestament', 'Old Testament', ['oldtestament', 'firstreading', 'firstlesson', 'reading1', 'ot']],
  ['psalm', 'Psalms', ['psalms', 'psalm']],
  ['epistle', 'New Testament/Epistle', ['newtestamentepistle', 'newtestament', 'epistle', 'secondlesson', 'reading2', 'nt']],
  ['gospel', 'Gospel', ['gospel', 'gospels', 'thirdreading', 'reading3']],
  ['hymns', 'MHB & CAN', ['mhbcan', 'mhbcanticles', 'hymns', 'hymn', 'mhb']],
  ['serviceLabel', 'Service', ['service', 'servicelabel', 'occasion', 'special', 'servicename']],
  ['notes', 'Notes', ['notes', 'note', 'remarks']],
];
const REQUIRED = ['serviceDate', 'title', 'colour'];
const norm = (h) => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * For each field, the index of the column that holds it (or -1). Exact names first
 * ("Hymn 1", "Liturgical Colour"), then a column whose name contains one of the
 * field's names ("Name of Sunday" holds the title), never reusing a column.
 */
function mapColumns(headers) {
  const used = new Set();
  const mapping = Object.fromEntries(FIELDS.map(([key]) => [key, -1]));
  const names = headers.map(norm);
  const take = (key, test) => {
    const i = names.findIndex((h, idx) => !used.has(idx) && h && test(h));
    if (i >= 0) { mapping[key] = i; used.add(i); }
  };
  for (const [key, , aliases] of FIELDS) take(key, (h) => aliases.includes(h));
  for (const [key, , aliases] of FIELDS) {
    if (mapping[key] < 0) take(key, (h) => aliases.some((a) => a.length >= 5 && h.includes(a)) || (key === 'title' && /name|title/.test(h)));
  }
  return mapping;
}

const clean = (v, max = 300) => {
  const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
  return s || null;
};

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** "March", "mar" or "3" to 3; anything else null. */
function parseMonth(v) {
  const t = String(v == null ? '' : v).trim().toLowerCase();
  if (/^\d{1,2}$/.test(t)) return Number(t) >= 1 && Number(t) <= 12 ? Number(t) : null;
  const i = MONTHS.indexOf(t.slice(0, 3));
  return i >= 0 && /^[a-z]+\.?$/.test(t) ? i + 1 : null;
}

/**
 * The service's date. The Lectionary prints a month name and a day number with no year,
 * so a bare day ("6", "Wed 18", "18th") takes the month above it and the year the
 * operator chose; anything else is read as a whole date (2026-04-05, 5/4/2026).
 */
function dateFrom(cell, ctx) {
  const text = String(cell == null ? '' : cell).trim();
  const bare = /^(?:[a-z]{3,9}\.?\s*)?(\d{1,2})(?:st|nd|rd|th)?$/i.exec(text);
  if (bare && ctx.month) {
    const d = new Date(Date.UTC(ctx.year, ctx.month - 1, Number(bare[1])));
    return d.getUTCMonth() === ctx.month - 1 && d.getUTCDate() === Number(bare[1]) ? d.toISOString().slice(0, 10) : null;
  }
  return imp.parseDate(text);
}

/** "13, 308, 781, 351/171" to ['13', '308', '781', '351/171']: a "/" is a choice and stays in one. */
function splitHymns(v) {
  return String(v == null ? '' : v).split(/[,;\n]+/).map((h) => clean(h, 40)).filter(Boolean).slice(0, 12);
}

const isTeaching = (v) => /teaching\s+service/i.test(String(v || ''));

/** One spreadsheet row to an Almanac entry, or { error }. ctx: { year, month } (month carried from the row above). */
function rowToEntry(row, mapping, ctx = {}) {
  const get = (key) => (mapping[key] >= 0 ? row[mapping[key]] : '');
  const date = dateFrom(get('serviceDate'), { year: ctx.year || new Date().getUTCFullYear(), month: ctx.month || null });
  if (!date) return { error: `"${clean(get('serviceDate'), 40) || ''}" is not a date it can read (a day number needs the month above it, and whole dates more than a year ahead are not accepted)` };
  const title = clean(get('title'), 200);
  if (!title) return { error: 'there is no name for the service' };
  const colour = parseColour(get('colour'));
  if (!colour) return { error: `"${clean(get('colour'), 30) || ''}" is not one of white, green, violet or red` };
  const entry = {
    serviceDate: new Date(`${date}T00:00:00Z`),
    serviceLabel: clean(get('serviceLabel'), 80) || '',
    title,
    colour,
    teachingService: false,
  };
  for (const key of ['theme', 'oldTestament', 'psalm', 'epistle', 'gospel']) {
    const v = get(key);
    if (isTeaching(v)) { entry.teachingService = true; entry[key] = null; } else entry[key] = clean(v);
  }
  entry.hymns = splitHymns(get('hymns'));
  entry.notes = clean(get('notes'), 1000);
  return { entry };
}

/**
 * A whole uploaded file: { entries, problems } or { error }. `problems` are rows that
 * could not be read, with the spreadsheet row number, so the operator can fix them.
 */
function readAlmanac(buffer, fileName, { year = new Date().getUTCFullYear() } = {}) {
  const sheet = imp.readSheet(buffer, fileName);
  if (sheet.error) return { error: sheet.error.replace('at least one member', 'at least one service') };
  const mapping = mapColumns(sheet.headers);
  const missing = FIELDS.filter(([key]) => REQUIRED.includes(key) && mapping[key] < 0).map(([, label]) => label);
  if (missing.length) {
    return { error: `The file needs a ${missing.join(', ')} column. Download the template to see the columns.` };
  }
  const entries = [];
  const problems = [];
  const seen = new Set();
  let month = null;
  sheet.rows.forEach((row, i) => {
    if (mapping.month >= 0) month = parseMonth(row[mapping.month]) || month;
    const r = rowToEntry(row, mapping, { year, month });
    if (r.error) { problems.push({ row: i + 2, message: r.error }); return; }
    const key = `${r.entry.serviceDate.toISOString().slice(0, 10)}|${r.entry.serviceLabel}`;
    if (seen.has(key)) { problems.push({ row: i + 2, message: 'the same date and service appears earlier in the file' }); return; }
    seen.add(key);
    entries.push(r.entry);
  });
  return { entries, problems };
}

const TEMPLATE_HEADER = FIELDS.map(([, label]) => label);
// Month is written once and carried down to the rows below it, as in the printed Lectionary.
const TEMPLATE_ROWS = [
  ['December', '20', 'Fourth Sunday of Advent', 'Violet', '', 'Isaiah 7:10-16', 'Psalm 80:1-7, 17-19', 'Romans 1:1-7', 'Matthew 1:18-25', '13, 308, 781, 351/171', '', ''],
  ['', '24', 'Christmas Eve', 'White', 'The light has come', 'Isaiah 9:2-7', 'Psalm 96', 'Titus 2:11-14', 'Luke 2:1-14', '98, 101, 104, 110', 'Christmas Eve', 'Candlelight service'],
  ['', '25', 'Christmas Day', 'Gold/White', '', 'Isaiah 52:7-10', 'Psalm 98', 'Hebrews 1:1-4', 'John 1:1-14', '99, 102, 105, 111', 'Christmas Day', ''],
  ['', '27', 'First Sunday after Christmas', 'White', '', '', 'TEACHING SERVICE', '', '', '', '', ''],
];

module.exports = { parseMonth, splitHymns, FIELDS, REQUIRED, mapColumns, rowToEntry, readAlmanac, TEMPLATE_HEADER, TEMPLATE_ROWS };
