'use strict';
// Platform > Almanac: the one shared Almanac every church reads. The operator loads
// each half-year here, from the Church's published Almanac, once for all churches:
// by spreadsheet (CSV or Excel) or one service at a time. Churches only read it
// (routes-pg-html/almanac.js); they apply the colour for their own app.

const multer = require('multer');
const asyncHandler = require('../lib/async-handler');
const { esc } = require('../lib/format');
const { pageHero, listCard, table } = require('../lib/views');
const { sendCsv } = require('../lib/csv');
const { flash } = require('../lib/tenant-flash');
const { csrfValid } = require('../lib/tenant-csrf');
const { db: rawDb } = require('../lib/tenant');
const { operatorLayout } = require('../lib/operator-shell');
const { requireOperator, logPlatformEvent } = require('../lib/platform-operators');
const L = require('../lib/liturgical');
const A = require('../lib/almanac-import');
const imp = require('../lib/member-import');
const { chip, colourOptions, shortDate } = require('../lib/almanac-ui');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: imp.MAX_FILE_BYTES, files: 1 } });

function page(res, opts) {
  return res.send(operatorLayout({ ...opts, operator: res.locals.operator, flash: res.locals.flash, flashType: res.locals.flashType }));
}
const KEYS = A.FIELDS.map(([key]) => key);
const day = (d) => new Date(d).toISOString().slice(0, 10);
const halfKey = (h) => `${h.year}-${h.half}`;
const shiftHalf = ({ year, half }, by) => {
  const n = year * 2 + (half - 1) + by;
  return { year: Math.floor(n / 2), half: (n % 2) + 1 };
};
function parseHalf(q) {
  const m = /^(\d{4})-([12])$/.exec(String(q || ''));
  return m && Number(m[1]) >= 2000 && Number(m[1]) <= 2100 ? { year: Number(m[1]), half: Number(m[2]) } : L.halfYearOf(new Date());
}
const idOf = (req) => { const n = Number(req.params.id); return Number.isInteger(n) && n > 0 ? n : null; };

/** The form's fields to an entry, with the same rules as a spreadsheet row. */
function entryFromForm(b) {
  const mapping = Object.fromEntries(KEYS.map((k, i) => [k, i]));
  const r = A.rowToEntry(KEYS.map((k) => b[k]), mapping);
  if (r.entry && b.teachingService) r.entry.teachingService = true;
  return r;
}

function formFields(e = {}) {
  const v = (k) => esc(e[k] || '');
  return `
    <label>Date<input type="date" name="serviceDate" required value="${e.serviceDate ? esc(day(e.serviceDate)) : ''}"></label>
    <label>Service<input name="serviceLabel" maxlength="80" value="${v('serviceLabel')}" placeholder="Leave empty for the ordinary service"><span class="hint">Only when a date has more than one: Christmas Eve, Christmas Day …</span></label>
    <label class="wide">Name<input name="title" required maxlength="200" value="${v('title')}" placeholder="e.g. Third Sunday in Lent"></label>
    <label>Colour<select name="colour">${colourOptions(e.colour || 'GREEN')}</select></label>
    <label class="wide">Theme<input name="theme" maxlength="300" value="${v('theme')}"></label>
    <label>Old Testament<input name="oldTestament" maxlength="300" value="${v('oldTestament')}"></label>
    <label>Psalm<input name="psalm" maxlength="300" value="${v('psalm')}"></label>
    <label>New Testament / Epistle<input name="epistle" maxlength="300" value="${v('epistle')}"></label>
    <label>Gospel<input name="gospel" maxlength="300" value="${v('gospel')}"></label>
    <label class="wide">Hymns (MHB &amp; Canticles)<input name="hymns" maxlength="300" value="${esc((e.hymns || []).join(', '))}" placeholder="13, 308, 781, 351/171"><span class="hint">In the order sung, separated by commas. A / between numbers is a choice.</span></label>
    <label class="check"><input type="checkbox" name="teachingService" value="1"${e.teachingService ? ' checked' : ''}> Teaching service (no readings set)</label>
    <label class="wide">Notes<input name="notes" maxlength="1000" value="${v('notes')}"></label>`;
}

function register(app) {
  app.get('/platform/almanac', requireOperator, asyncHandler(async (req, res) => {
    const half = parseHalf(req.query.half);
    const range = L.halfYearRange(half);
    const entries = await rawDb.almanacEntry.findMany({ where: { serviceDate: { gte: range.start, lte: range.end } }, orderBy: [{ serviceDate: 'asc' }, { serviceLabel: 'asc' }] });
    const rows = entries.map((e) => [
      `${esc(shortDate(e.serviceDate))}${e.serviceLabel ? `<small>${esc(e.serviceLabel)}</small>` : ''}`,
      `${esc(e.title)}${e.theme ? `<small>${esc(e.theme)}</small>` : ''}`,
      chip(e.colour),
      e.teachingService && !e.oldTestament && !e.psalm && !e.epistle && !e.gospel ? 'Teaching service' : (esc([e.oldTestament, e.psalm, e.epistle, e.gospel].filter(Boolean).join(' · ')) || '—'),
      esc((e.hymns || []).join(', ')) || '—',
      `<div class="platform-actions">
        <a class="btn ghost" href="/platform/almanac/${e.id}/edit">Edit</a>
        <form method="post" action="/platform/almanac/${e.id}/delete" class="inline platform-inline-form" data-confirm="Delete this service from the Almanac? It disappears for every church."><button type="submit" class="ghost">Delete</button></form>
      </div>`,
    ]);
    const body = `
      ${pageHero('Almanac', 'The services of each half-year, shared by every church: colour, theme, readings and hymns.')}
      <section class="card">
        <div class="card-head"><h2>Load a spreadsheet</h2><a href="/platform/almanac/template.csv">Download the template</a></div>
        <form class="form" method="post" action="/platform/almanac/import" enctype="multipart/form-data">
          <label>Year<input type="number" name="year" min="2000" max="2100" value="${new Date().getUTCFullYear()}" required><span class="hint">The Lectionary prints no year. A day number takes the month above it and this year.</span></label>
          <label class="wide">CSV or Excel file<input type="file" name="file" accept=".csv,.xlsx,.xls" required>
            <span class="hint">One row per service, with the Lectionary's columns: Month, Date, Name, Colour, Theme, Old Testament, Psalms, New Testament/Epistle, Gospel, MHB &amp; CAN. Needs a date, a name and a colour (white, green, violet or red); the rest is optional. A service already in the Almanac (same date) is updated, not duplicated.</span></label>
          <div class="actions"><button type="submit">Load into the Almanac</button></div>
        </form>
      </section>
      <section class="card">
        <div class="card-head"><h2>Add one service</h2></div>
        <form class="form" method="post" action="/platform/almanac">
          ${formFields()}
          <div class="actions"><button type="submit">Add to the Almanac</button></div>
        </form>
      </section>
      ${listCard({
        title: esc(L.halfYearLabel(half)), count: entries.length, countLabel: entries.length === 1 ? 'service' : 'services',
        note: '', inner: `<p class="muted-text"><a href="/platform/almanac?half=${halfKey(shiftHalf(half, -1))}">← Earlier</a> · <a href="/platform/almanac?half=${halfKey(shiftHalf(half, 1))}">Later →</a></p>${
          rows.length ? table(['Date', 'Service', 'Colour', 'Readings', 'Hymns', ''], rows, { keyCols: 2 }) : '<p class="muted-text">Nothing loaded for this half-year yet.</p>'}`,
      })}`;
    page(res, { title: 'Almanac', active: '/platform/almanac', body });
  }));

  app.get('/platform/almanac/template.csv', requireOperator, (req, res) => {
    sendCsv(res, 'almanac-template.csv', A.TEMPLATE_HEADER, A.TEMPLATE_ROWS);
  });

  app.get('/platform/almanac/:id(\\d+)/edit', requireOperator, asyncHandler(async (req, res) => {
    const id = idOf(req);
    const e = id ? await rawDb.almanacEntry.findUnique({ where: { id } }) : null;
    if (!e) { flash(req, 'That service is not in the Almanac.'); return res.redirect('/platform/almanac'); }
    const body = `
      ${pageHero('Edit a service', `${e.title}, ${shortDate(e.serviceDate)}`)}
      <section class="card">
        <form class="form" method="post" action="/platform/almanac/${e.id}">
          ${formFields(e)}
          <div class="actions"><a class="btn ghost" href="/platform/almanac?half=${halfKey(L.halfYearOf(e.serviceDate))}">Cancel</a><button type="submit">Save</button></div>
        </form>
      </section>`;
    page(res, { title: 'Edit a service', active: '/platform/almanac', body });
  }));

  app.post('/platform/almanac', requireOperator, asyncHandler(async (req, res) => {
    const r = entryFromForm(req.body || {});
    if (r.error) { flash(req, `Not added: ${r.error}.`); return res.redirect('/platform/almanac'); }
    const clash = await rawDb.almanacEntry.findUnique({ where: { serviceDate_serviceLabel: { serviceDate: r.entry.serviceDate, serviceLabel: r.entry.serviceLabel } } });
    if (clash) { flash(req, 'That date and service is already in the Almanac. Edit it instead.'); return res.redirect(`/platform/almanac/${clash.id}/edit`); }
    await rawDb.almanacEntry.create({ data: r.entry });
    await logPlatformEvent(req, { operator: res.locals.operator, event: 'platform.almanac_added', subject: `${day(r.entry.serviceDate)} ${r.entry.title}` });
    flash(req, 'Added to the Almanac. Every church can see it now.', 'success');
    res.redirect(`/platform/almanac?half=${halfKey(L.halfYearOf(r.entry.serviceDate))}`);
  }));

  app.post('/platform/almanac/:id(\\d+)', requireOperator, asyncHandler(async (req, res) => {
    const id = idOf(req);
    const existing = id ? await rawDb.almanacEntry.findUnique({ where: { id } }) : null;
    if (!existing) { flash(req, 'That service is not in the Almanac.'); return res.redirect('/platform/almanac'); }
    const r = entryFromForm(req.body || {});
    if (r.error) { flash(req, `Not saved: ${r.error}.`); return res.redirect(`/platform/almanac/${id}/edit`); }
    const clash = await rawDb.almanacEntry.findUnique({ where: { serviceDate_serviceLabel: { serviceDate: r.entry.serviceDate, serviceLabel: r.entry.serviceLabel } } });
    if (clash && clash.id !== id) { flash(req, 'Another service already has that date and service name.'); return res.redirect(`/platform/almanac/${id}/edit`); }
    await rawDb.almanacEntry.update({ where: { id }, data: r.entry });
    await logPlatformEvent(req, { operator: res.locals.operator, event: 'platform.almanac_changed', subject: `${day(r.entry.serviceDate)} ${r.entry.title}` });
    flash(req, 'Saved.', 'success');
    res.redirect(`/platform/almanac?half=${halfKey(L.halfYearOf(r.entry.serviceDate))}`);
  }));

  app.post('/platform/almanac/:id(\\d+)/delete', requireOperator, asyncHandler(async (req, res) => {
    const id = idOf(req);
    const e = id ? await rawDb.almanacEntry.findUnique({ where: { id } }) : null;
    if (e) {
      await rawDb.almanacEntry.delete({ where: { id } });
      await logPlatformEvent(req, { operator: res.locals.operator, event: 'platform.almanac_deleted', subject: `${day(e.serviceDate)} ${e.title}` });
      flash(req, 'Deleted from the Almanac.', 'success');
    }
    res.redirect(e ? `/platform/almanac?half=${halfKey(L.halfYearOf(e.serviceDate))}` : '/platform/almanac');
  }));

  // The upload is multipart, which the global CSRF check cannot read: check the token here, after multer.
  app.post('/platform/almanac/import', requireOperator, (req, res, next) => {
    upload.single('file')(req, res, (err) => {
      if (err) {
        flash(req, err.code === 'LIMIT_FILE_SIZE' ? 'The file is larger than 5 MB.' : 'The file could not be uploaded.');
        return res.redirect('/platform/almanac');
      }
      next();
    });
  }, asyncHandler(async (req, res) => {
    if (!csrfValid(req)) return res.status(403).send('Security check failed. Refresh the page and try again.');
    if (!req.file) { flash(req, 'Choose a file to load.'); return res.redirect('/platform/almanac'); }
    const read = A.readAlmanac(req.file.buffer, String(req.file.originalname || ''), { year: Number(req.body && req.body.year) >= 2000 && Number(req.body.year) <= 2100 ? Number(req.body.year) : new Date().getUTCFullYear() });
    if (read.error) { flash(req, read.error); return res.redirect('/platform/almanac'); }

    const existing = await rawDb.almanacEntry.findMany({
      where: { serviceDate: { in: read.entries.map((e) => e.serviceDate) } }, select: { serviceDate: true, serviceLabel: true },
    });
    const had = new Set(existing.map((e) => `${day(e.serviceDate)}|${e.serviceLabel}`));
    let created = 0;
    let updated = 0;
    for (let i = 0; i < read.entries.length; i += 100) {
      const chunk = read.entries.slice(i, i + 100);
      await rawDb.$transaction(chunk.map((e) => rawDb.almanacEntry.upsert({
        where: { serviceDate_serviceLabel: { serviceDate: e.serviceDate, serviceLabel: e.serviceLabel } }, create: e, update: e,
      })));
      for (const e of chunk) { if (had.has(`${day(e.serviceDate)}|${e.serviceLabel}`)) updated++; else created++; }
    }
    await logPlatformEvent(req, { operator: res.locals.operator, event: 'platform.almanac_loaded', subject: `${created} added, ${updated} updated, ${read.problems.length} skipped, from ${String(req.file.originalname || 'a file').slice(0, 120)}` });

    const problems = read.problems.length
      ? `<section class="card"><div class="card-head"><h2>${read.problems.length} row${read.problems.length === 1 ? '' : 's'} not loaded</h2></div>
          <p class="muted-text">Fix these in the spreadsheet and load it again. Rows that were fine are already in the Almanac, and loading them again changes nothing.</p>
          <ul>${read.problems.slice(0, 50).map((p) => `<li>Row ${p.row}: ${esc(p.message)}</li>`).join('')}</ul>${read.problems.length > 50 ? `<p class="muted-text">…and ${read.problems.length - 50} more.</p>` : ''}</section>`
      : '';
    const first = read.entries.length ? L.halfYearOf(read.entries[0].serviceDate) : L.halfYearOf(new Date());
    page(res, {
      title: 'Almanac loaded', active: '/platform/almanac',
      body: `${pageHero('Almanac loaded', `${created} added, ${updated} updated.`)}
        <section class="card"><p>Every church can see these services now.</p>
        <p><a class="btn" href="/platform/almanac?half=${halfKey(first)}">See ${esc(L.halfYearLabel(first))}</a></p></section>${problems}`,
    });
  }));
}

module.exports = { register };
