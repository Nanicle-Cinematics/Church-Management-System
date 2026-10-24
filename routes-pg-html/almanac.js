'use strict';
// The Almanac, for churches: the half-year's services (colour, theme, three
// readings, hymns), and the liturgical colour the admin applies to the app.
//
// The Almanac itself is shared by every church and loaded by the platform
// operator (routes-pg-html/platform-almanac.js). Everyone in a church can read it.
// Applying a colour is the church admin's, and reaches every user of that church
// (lib/liturgical.js).

const asyncHandler = require('../lib/async-handler');
const { esc } = require('../lib/format');
const { pageHero } = require('../lib/views');
const { flash } = require('../lib/tenant-flash');
const { logActivity } = require('../lib/tenant-activity');
const L = require('../lib/liturgical');
const { chip, entryCard, colourOptions, shortDate } = require('../lib/almanac-ui');
const { planPreacherText } = require('../lib/preachers');

function requireAdmin(req, res, next) {
  if (res.locals.user && res.locals.user.role === 'ADMIN') return next();
  return res.status(403).send('Forbidden');
}

// Where a form may send the admin back to: never an address from the request.
const RETURN_TO = new Set(['/', '/almanac']);
const back = (req) => (RETURN_TO.has(String(req.body && req.body.return_to)) ? req.body.return_to : '/almanac');

/** "2026-2" is July to December 2026; anything else is the current half-year. */
function parseHalf(q, now) {
  const m = /^(\d{4})-([12])$/.exec(String(q || ''));
  return m && Number(m[1]) >= 2000 && Number(m[1]) <= 2100 ? { year: Number(m[1]), half: Number(m[2]) } : L.halfYearOf(now);
}
const halfKey = (h) => `${h.year}-${h.half}`;
const shiftHalf = ({ year, half }, by) => {
  const n = year * 2 + (half - 1) + by;
  return { year: Math.floor(n / 2), half: (n % 2) + 1 };
};

function register(app) {
  app.get('/almanac', asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    const db = res.locals.db;
    const user = res.locals.user;
    const now = new Date();
    const half = parseHalf(req.query.half, now);
    const range = L.halfYearRange(half);
    const [entries, assignment, thisWeek, plans] = await Promise.all([
      db.almanacEntry.findMany({ where: { serviceDate: { gte: range.start, lte: range.end } }, orderBy: [{ serviceDate: 'asc' }, { serviceLabel: 'asc' }] }),
      L.activeAssignment(db, now),
      L.entryForWeek(db, now),
      db.preachingPlan.findMany({
        where: { deletedAt: null, preachDate: { gte: range.start, lte: range.end } }, orderBy: { id: 'asc' },
        include: { preacher: { select: { code: true, name: true } }, member: { select: { firstName: true, lastName: true } } },
      }),
    ]);
    const preaching = new Map();
    for (const p of plans) {
      const text = planPreacherText(p);
      if (text) preaching.set(L.ymd(p.preachDate), [...(preaching.get(L.ymd(p.preachDate)) || []), text]);
    }
    const isAdmin = user.role === 'ADMIN';
    const setter = assignment && assignment.setBy ? await db.user.findFirst({ where: { id: assignment.setBy }, select: { displayName: true, username: true } }) : null;

    const current = assignment && L.isColour(assignment.colour)
      ? `<p class="lit-now">${chip(assignment.colour)} <span>for ${assignment.scope === 'MONTH' ? 'the month' : 'the week'}, until ${esc(shortDate(assignment.endsOn))}${setter ? `, set by ${esc(setter.displayName || setter.username)}` : ''}.</span></p>`
      : '<p class="muted-text">The app is wearing its normal colours.</p>';
    const suggested = thisWeek && L.isColour(thisWeek.colour) ? thisWeek.colour : (assignment && L.isColour(assignment.colour) ? assignment.colour : 'GREEN');
    const controls = isAdmin ? `
      <form class="form" method="post" action="/almanac/colour" data-no-confirm="1" data-confirm="Apply this colour to everyone in your church?">
        <input type="hidden" name="almanacId" value="${thisWeek ? thisWeek.id : ''}">
        <input type="hidden" name="return_to" value="/almanac">
        <label>Colour<select name="colour">${colourOptions(suggested)}</select>${thisWeek ? `<span class="hint">This week's Almanac colour is ${esc(L.colourLabel(thisWeek.colour))}.</span>` : ''}</label>
        <label>For<select name="scope"><option value="WEEK">This week (Sunday to Saturday)</option><option value="MONTH">From today to the end of the month</option></select></label>
        <div class="actions"><button type="submit">Apply to the whole church</button></div>
      </form>
      ${assignment ? `<form method="post" action="/almanac/colour/clear" data-confirm="Go back to the normal colours?"><input type="hidden" name="return_to" value="/almanac"><button type="submit" class="ghost">Use the normal colours</button></form>` : ''}`
      : '<p class="muted-text">Your church admin chooses the colour. Everyone sees it.</p>';

    const prev = halfKey(shiftHalf(half, -1));
    const next = halfKey(shiftHalf(half, 1));
    const list = entries.length
      ? `<ul class="almanac-list">${entries.map((e) => entryCard(e, { now: Boolean(thisWeek && e.id === thisWeek.id), preachers: preaching.get(L.ymd(e.serviceDate)) || [] })).join('')}</ul>`
      : `<div class="card"><p class="muted-text">The Almanac for ${esc(L.halfYearLabel(half))} has not been loaded yet. It is added by Church Manager support; check back soon.</p></div>`;

    const body = `
      ${pageHero('Almanac', 'The services of the half-year: colour, theme, scripture readings and hymns.')}
      <section class="card" id="colour">
        <div class="card-head"><h2>Colour of the app</h2></div>
        ${current}
        ${controls}
      </section>
      <section>
        <div class="card-head"><h2>${esc(L.halfYearLabel(half))}</h2>
          <span class="meta"><a href="/almanac?half=${prev}">← Earlier</a> · <a href="/almanac?half=${next}">Later →</a>${halfKey(half) !== halfKey(L.halfYearOf(now)) ? ' · <a href="/almanac">This half-year</a>' : ''}</span></div>
        ${list}
      </section>`;
    res.page({ title: 'Almanac', active: '/almanac', noHeader: true, body });
  }));

  app.post('/almanac/colour', requireAdmin, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const b = req.body || {};
    if (!L.isColour(b.colour)) { flash(req, 'Choose one of the liturgical colours.'); return res.redirect(back(req)); }
    const scope = b.scope === 'MONTH' ? 'MONTH' : 'WEEK';
    const id = Number(b.almanacId);
    const entry = Number.isInteger(id) && id > 0 ? await db.almanacEntry.findUnique({ where: { id } }) : null;
    await L.applyColour(db, res.locals.churchId, { colour: b.colour, scope, userId: res.locals.user.id, almanacId: entry ? entry.id : null });
    await logActivity(db, 'almanac_colour_set', `Liturgical colour set to ${L.colourLabel(b.colour)} for the ${scope === 'MONTH' ? 'month' : 'week'}`, '/almanac', res.locals.user.id);
    flash(req, `${L.colourLabel(b.colour)} is now the colour of the app for everyone in your church, ${scope === 'MONTH' ? 'until the end of the month' : 'for this week'}.`, 'success');
    res.redirect(back(req));
  }));

  app.post('/almanac/colour/clear', requireAdmin, asyncHandler(async (req, res) => {
    await L.clearColour(res.locals.db, res.locals.churchId);
    await logActivity(res.locals.db, 'almanac_colour_cleared', 'Liturgical colour cleared: back to the normal colours', '/almanac', res.locals.user.id);
    flash(req, 'The app is back to its normal colours.', 'success');
    res.redirect(back(req));
  }));

}

module.exports = { register };
