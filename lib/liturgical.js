'use strict';
// The Almanac's liturgical colour, applied to a whole church's app.
//
// An admin applies a colour for the week or the month (routes-pg-html/almanac.js),
// stored per church in church_colours. Every page then carries
// <html data-liturgical="green">, so everyone in that church, on any device, sees
// it on their next page load: there is no per-user setting to keep in step.
// Outside the dates the admin chose, the app wears its normal colours.
//
// All dates are UTC calendar days, matching how the app stores dates (Ghana is on UTC).

const { PALETTE, KEYS } = require('./liturgical-palette');

const COLOURS = KEYS;
const isColour = (v) => typeof v === 'string' && Object.prototype.hasOwnProperty.call(PALETTE, v);
const colourLabel = (key) => (isColour(key) ? PALETTE[key].label : '');

// What people write in an Almanac spreadsheet, mapped to our four. The Lectionary writes
// "Gold/White" for Christmas Day, so a cell is read word by word and the first colour wins.
const ALIASES = { WHITE: 'WHITE', GOLD: 'WHITE', GREEN: 'GREEN', VIOLET: 'VIOLET', PURPLE: 'VIOLET', RED: 'RED' };
function parseColour(input) {
  for (const word of String(input || '').toUpperCase().split(/[^A-Z]+/)) {
    if (Object.prototype.hasOwnProperty.call(ALIASES, word)) return ALIASES[word];
  }
  return null;
}

// ---- dates -----------------------------------------------------------------

const DAY = 86400000;
/** Midnight UTC of the day a Date (or 'YYYY-MM-DD') falls on. */
function toDay(d) {
  const t = typeof d === 'string' ? new Date(`${d.slice(0, 10)}T00:00:00Z`) : new Date(d);
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
}
const ymd = (d) => toDay(d).toISOString().slice(0, 10);
const addDays = (d, n) => new Date(toDay(d).getTime() + n * DAY);

/** The week a day belongs to, Sunday to Saturday. */
function weekRange(d) {
  const day = toDay(d);
  const start = addDays(day, -day.getUTCDay());
  return { start, end: addDays(start, 6) };
}
function endOfMonth(d) {
  const day = toDay(d);
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth() + 1, 0));
}
/** The Almanac is published for January to June and July to December. */
function halfYearOf(d) {
  const day = toDay(d);
  return { year: day.getUTCFullYear(), half: day.getUTCMonth() < 6 ? 1 : 2 };
}
function halfYearRange({ year, half }) {
  return half === 1
    ? { start: new Date(Date.UTC(year, 0, 1)), end: new Date(Date.UTC(year, 5, 30)) }
    : { start: new Date(Date.UTC(year, 6, 1)), end: new Date(Date.UTC(year, 11, 31)) };
}
const halfYearLabel = ({ year, half }) => (half === 1 ? `January to June ${year}` : `July to December ${year}`);

// ---- the church's current colour -------------------------------------------

// One lookup per church per minute. A change made through applyColour/clearColour
// drops the entry straight away; the minute only matters if the app ever runs on
// more than one machine.
const CACHE_MS = 60 * 1000;
const cache = new Map();
const forgetColour = (churchId) => cache.delete(churchId);

/** The colour in force for this church today, or null for the normal look. `db` is that church's scoped client. */
async function currentColour(db, churchId, now = new Date()) {
  const day = ymd(now);
  const hit = cache.get(churchId);
  if (hit && hit.day === day && hit.until > Date.now()) return hit.colour;
  const today = toDay(now);
  const row = await db.churchColour.findFirst({
    where: { startsOn: { lte: today }, endsOn: { gte: today } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { colour: true },
  });
  const colour = row && isColour(row.colour) ? row.colour : null;
  cache.set(churchId, { day, until: Date.now() + CACHE_MS, colour });
  return colour;
}

/** The assignment in force today with who set it and until when, for the Almanac page. */
async function activeAssignment(db, now = new Date()) {
  const today = toDay(now);
  return db.churchColour.findFirst({
    where: { startsOn: { lte: today }, endsOn: { gte: today } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
}

/** Apply a colour for the week (Sunday to Saturday) or from today to the end of the month. */
async function applyColour(db, churchId, { colour, scope, userId = null, almanacId = null, now = new Date() }) {
  if (!isColour(colour)) throw new Error('Choose one of the liturgical colours.');
  const today = toDay(now);
  const range = scope === 'MONTH' ? { start: today, end: endOfMonth(today) } : weekRange(today);
  const row = await db.churchColour.create({
    data: { colour, scope: scope === 'MONTH' ? 'MONTH' : 'WEEK', startsOn: range.start, endsOn: range.end, almanacId, setBy: userId },
  });
  forgetColour(churchId);
  return row;
}

/** Back to the normal colours from today: ends what is running and drops what was set ahead. */
async function clearColour(db, churchId, now = new Date()) {
  const today = toDay(now);
  await db.churchColour.deleteMany({ where: { startsOn: { gte: today } } });
  await db.churchColour.updateMany({ where: { startsOn: { lt: today }, endsOn: { gte: today } }, data: { endsOn: addDays(today, -1) } });
  forgetColour(churchId);
}

// ---- the Almanac -----------------------------------------------------------

/** This week's entry: the Sunday service if there is one, else the first special service. `db` may be any client (the table is shared). */
async function entryForWeek(db, now = new Date()) {
  const { start, end } = weekRange(now);
  const entries = await db.almanacEntry.findMany({ where: { serviceDate: { gte: start, lte: end } }, orderBy: [{ serviceDate: 'asc' }, { serviceLabel: 'asc' }] });
  return entries.find((e) => e.serviceLabel === '') || entries[0] || null;
}

/** What the Almanac sets for one date (the ordinary service first), or null. */
async function entryForDate(db, date) {
  const day = toDay(date);
  const entries = await db.almanacEntry.findMany({ where: { serviceDate: day }, orderBy: { serviceLabel: 'asc' } });
  return entries.find((e) => e.serviceLabel === '') || entries[0] || null;
}

/**
 * The Almanac in a sentence or two for a preacher's reminder. `short` (for a text message,
 * which is paid by the part) is the service, colour and theme; the full one adds the readings
 * and hymns. Empty when there is no entry.
 */
function reminderText(entry, { short = false } = {}) {
  if (!entry) return '';
  const parts = [`Almanac: ${entry.title}${isColour(entry.colour) ? ` (${colourLabel(entry.colour)})` : ''}.`];
  if (entry.theme) parts.push(`Theme: ${entry.theme}.`);
  if (!short) {
    if (entry.teachingService) parts.push('Teaching service.');
    const readings = [['Old Testament', entry.oldTestament], ['Psalm', entry.psalm], ['Epistle', entry.epistle], ['Gospel', entry.gospel]].filter(([, v]) => v);
    if (readings.length) parts.push(`Readings: ${readings.map(([k, v]) => `${k} ${v}`).join('; ')}.`);
    if ((entry.hymns || []).length) parts.push(`Hymns: ${entry.hymns.join(', ')}.`);
  }
  return parts.join(' ');
}

/**
 * The entry to offer an admin as this week's colour, or null: only to an admin, only
 * when no colour is in force, only when the Almanac has an entry for this week.
 * It cannot be put off: it comes back on every visit until a colour is chosen, and then not
 * again until that week or month is over.
 */
async function promptEntry(db, churchId, user, _session, now = new Date()) {
  if (!user || user.role !== 'ADMIN' || user.supportView) return null;
  if (await currentColour(db, churchId, now)) return null;
  const entry = await entryForWeek(db, now);
  return entry && isColour(entry.colour) ? entry : null;
}

module.exports = {
  PALETTE, COLOURS, isColour, colourLabel, parseColour,
  toDay, ymd, addDays, weekRange, endOfMonth, halfYearOf, halfYearRange, halfYearLabel,
  currentColour, activeAssignment, forgetColour, applyColour, clearColour, entryForWeek, entryForDate, reminderText, promptEntry,
};
