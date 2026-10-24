'use strict';
// The Almanac's pure parts: the palette (readable in light and dark, and the
// generated stylesheet matches it), the date rules for "this week" and "this
// month", the spreadsheet reader, and the markup helpers. No database.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { PALETTE, KEYS } = require('../lib/liturgical-palette');
const L = require('../lib/liturgical');
const A = require('../lib/almanac-import');
const U = require('../lib/almanac-ui');
const { build } = require('../scripts/build-liturgical-css');
const { csvEscape } = require('../lib/csv');

const lum = (h) => {
  const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const panel = { light: '#ffffff', dark: '#131318' };
const iso = (d) => L.ymd(d);

test('the Lectionary\'s four liturgical colours, and every one is readable in light and dark', () => {
  assert.deepStrictEqual(KEYS.slice().sort(), ['GREEN', 'RED', 'VIOLET', 'WHITE']);
  const low = [];
  for (const [key, p] of Object.entries(PALETTE)) {
    for (const mode of ['light', 'dark']) {
      const c = p[mode];
      const checks = [
        ['button text on the accent', ratio(c.on, c.accent), 4.5],
        ['button text when hovered', ratio(c.on, c.hover), 4.5],
        ['links on a card', ratio(c.ink, panel[mode]), 4.5],
        ['text on the soft chip', ratio(c.ink, c.soft), 4.5],
        ['icons and focus rings on a card', ratio(c.accent, panel[mode]), 3],
        ['banner text on the deep stop', ratio('#ffffff', c.g1), 4.5],
        ['banner text on the middle stop', ratio('#ffffff', c.g2), 4.5],
      ];
      for (const [what, r, min] of checks) if (r < min) low.push(`${key} ${mode}: ${what} is ${r.toFixed(2)}, needs ${min}`);
    }
  }
  assert.deepStrictEqual(low, []);
});

test('public/liturgical.css is exactly what the palette generates', () => {
  const file = fs.readFileSync(path.join(__dirname, '..', 'public', 'liturgical.css'), 'utf8');
  assert.strictEqual(file, build(), 'run: node scripts/build-liturgical-css.js');
  for (const key of KEYS) {
    assert.ok(file.includes(`:root[data-liturgical="${key.toLowerCase()}"] {`), `${key} light`);
    assert.ok(file.includes(`:root[data-theme="dark"][data-liturgical="${key.toLowerCase()}"] {`), `${key} dark`);
    assert.ok(file.includes(`[data-c="${key}"] { --dot: ${PALETTE[key].swatch}; }`), `${key} chip`);
  }
});

test('the week runs Sunday to Saturday, and the month ends on its last day', () => {
  for (const day of ['2026-10-25', '2026-10-28', '2026-10-31']) {
    const w = L.weekRange(day);
    assert.strictEqual(iso(w.start), '2026-10-25', day);
    assert.strictEqual(iso(w.end), '2026-10-31', day);
  }
  assert.strictEqual(iso(L.weekRange('2026-11-01').start), '2026-11-01', 'a Sunday starts its own week');
  assert.strictEqual(iso(L.weekRange('2026-12-30').end), '2027-01-02', 'a week can cross the new year');
  assert.strictEqual(iso(L.endOfMonth('2028-02-10')), '2028-02-29', 'leap year');
  assert.strictEqual(iso(L.endOfMonth('2026-12-03')), '2026-12-31');
  assert.deepStrictEqual(L.halfYearOf('2026-06-30'), { year: 2026, half: 1 });
  assert.deepStrictEqual(L.halfYearOf('2026-07-01'), { year: 2026, half: 2 });
  assert.strictEqual(iso(L.halfYearRange({ year: 2026, half: 2 }).end), '2026-12-31');
  assert.strictEqual(L.halfYearLabel({ year: 2026, half: 1 }), 'January to June 2026');
});

test('colour names from a spreadsheet map to our four, anything else is refused', () => {
  const cases = { green: 'GREEN', Violet: 'VIOLET', PURPLE: 'VIOLET', gold: 'WHITE', White: 'WHITE', 'Gold/White': 'WHITE', ' red ': 'RED', Blue: null, pink: null, '': null };
  for (const [input, want] of Object.entries(cases)) assert.strictEqual(L.parseColour(input), want, input);
  assert.strictEqual(L.isColour('GREEN'), true);
  assert.strictEqual(L.isColour('green'), false, 'stored colours are the upper-case keys');
  assert.strictEqual(L.isColour('PINK'), false);
  assert.strictEqual(L.isColour('constructor'), false, 'not fooled by object properties');
});

test('the template file reads back exactly as the Almanac the operator would load', () => {
  const csv = [A.TEMPLATE_HEADER, ...A.TEMPLATE_ROWS].map((r) => r.map(csvEscape).join(',')).join('\r\n');
  const r = A.readAlmanac(Buffer.from(csv), 'almanac.csv', { year: 2026 });
  assert.strictEqual(r.error, undefined);
  assert.strictEqual(r.problems.length, 0);
  assert.strictEqual(r.entries.length, A.TEMPLATE_ROWS.length);
  const eve = r.entries.find((e) => e.serviceLabel === 'Christmas Eve');
  assert.ok(eve, 'a second service on a date is kept apart by its name');
  assert.strictEqual(iso(eve.serviceDate), '2026-12-24', 'the month is carried down from the row above, the year is the one chosen');
  assert.deepStrictEqual([eve.oldTestament, eve.psalm, eve.epistle, eve.gospel, eve.hymns], ['Isaiah 9:2-7', 'Psalm 96', 'Titus 2:11-14', 'Luke 2:1-14', ['98', '101', '104', '110']]);
  const day = r.entries.find((e) => e.title === 'Christmas Day');
  assert.strictEqual(day.colour, 'WHITE', 'Gold/White is white');
  const advent = r.entries.find((e) => e.title === 'Fourth Sunday of Advent');
  assert.deepStrictEqual([advent.colour, advent.hymns], ['VIOLET', ['13', '308', '781', '351/171']], 'a / is a choice and stays in one hymn');
  const teaching = r.entries.find((e) => e.teachingService);
  assert.deepStrictEqual([iso(teaching.serviceDate), teaching.psalm, teaching.oldTestament], ['2026-12-27', null, null], 'TEACHING SERVICE sets the flag instead of being a psalm');
});

test('the Lectionary layout: month names, bare day numbers, merged month cells and headers as printed', () => {
  const csv = [
    'Month,Date,NAME,COLOUR,THEME,OLD TESTAMENT,PSALMS,NEW TESTAMENT/EPISTLE,GOSPEL,MHB & CAN',
    'January,4,Epiphany of the Lord,White,Arise,Isaiah 60:1-6,Psalm 72,Ephesians 3:1-12,Matthew 2:1-12,"1, 2, 3, 4"',
    ',Wed 18th,Midweek,Green,,,,,,',
    'february,29,Not a day in 2026,Green,,,,,,',
    'Feb,1,Sunday in February,Violet,,,,,,',
  ].join('\r\n');
  const r = A.readAlmanac(Buffer.from(csv), 'lectionary.csv', { year: 2026 });
  assert.deepStrictEqual(r.entries.map((e) => iso(e.serviceDate)), ['2026-01-04', '2026-01-18', '2026-02-01']);
  assert.deepStrictEqual(r.problems.map((p) => p.row), [4]);
  assert.strictEqual(r.entries[0].title, 'Epiphany of the Lord');
  assert.strictEqual(r.entries[0].epistle, 'Ephesians 3:1-12');
  assert.strictEqual(A.parseMonth('Sept'), 9);
  assert.strictEqual(A.parseMonth('13'), null);
  assert.deepStrictEqual(A.splitHymns('13, 308;781\n351/171,'), ['13', '308', '781', '351/171']);
});

test('a messy spreadsheet loads what it can and says exactly what it could not, by row', () => {
  const csv = [
    'Sunday date,Name of Sunday,Liturgical Color,Theme,Old Testament,Gospel,MHB & CAN',
    '15/11/2026,Remembrance Sunday,Violet,Peace,Micah 4:1-4,John 14:27,"1, 2, 3, 4"',
    'not a date,X,green,,,,',
    '22/11/2026,Christ the King,pink,,,,',
    '29/11/2026,,green,,,,',
    '15/11/2026,Same day again,green,,,,',
  ].join('\r\n');
  const r = A.readAlmanac(Buffer.from(csv), 'messy.csv');
  assert.strictEqual(r.entries.length, 1);
  assert.strictEqual(r.entries[0].colour, 'VIOLET');
  assert.strictEqual(r.entries[0].gospel, 'John 14:27');
  assert.deepStrictEqual(r.problems.map((p) => p.row), [3, 4, 5, 6], 'spreadsheet row numbers, counting the header as row 1');
  assert.match(r.problems[0].message, /not a date/);
  assert.match(r.problems[1].message, /white, green, violet or red/);
  assert.match(r.problems[2].message, /no name/);
  assert.match(r.problems[3].message, /earlier in the file/);
});

test('a file without the three required columns is refused, with a way forward', () => {
  assert.match(A.readAlmanac(Buffer.from('Date,Name\r\n2026-11-01,X'), 'a.csv').error, /needs a Colour column/);
  assert.match(A.readAlmanac(Buffer.from('Colour\r\ngreen'), 'a.csv').error, /Date, Name|Date/);
  assert.match(A.readAlmanac(Buffer.from(''), 'a.csv').error, /empty/);
  assert.match(A.readAlmanac(Buffer.from('x'), 'a.pdf').error, /csv|xlsx/i);
});

test('markup: a title cannot inject HTML, the colour is always named, and the prompt posts to the right place', () => {
  const e = { id: 7, serviceDate: new Date('2026-11-01T00:00:00Z'), serviceLabel: '', title: 'All <b>Saints</b>', colour: 'WHITE', theme: '"Hope"', oldTestament: 'Rev 7:9-17', psalm: '', epistle: '', gospel: 'Matt 5:1-12', hymns: ['56', '340'], teachingService: false, notes: null };
  const card = U.entryCard(e, { now: true });
  assert.ok(card.includes('All &lt;b&gt;Saints&lt;/b&gt;') && !card.includes('<b>Saints'));
  assert.ok(card.includes('White'), 'the colour is named, not only shown');
  assert.strictEqual((card.match(/<li>/g) || []).length, 4, 'two readings and two hymns were given; empty ones are left out');
  assert.ok(card.includes('is-now') && card.includes('this week'));
  const prompt = U.promptHtml(e, '/');
  assert.match(prompt, /action="\/almanac\/colour"/);
  assert.match(prompt, /name="scope" value="WEEK"/);
  assert.match(prompt, /name="scope" value="MONTH"/);
  assert.match(prompt, /formaction="\/almanac\/colour\/later"/);
  assert.ok(!/\son[a-z]+=|<script/i.test(prompt + card), 'no inline script or handlers (the page policy forbids them)');
});
