'use strict';
// Platform › Announcements: notices shown at the top of every signed-in
// church page while they run (lib/announcements.js), optionally emailed to
// every church's admins.

const asyncHandler = require('../lib/async-handler');
const { esc } = require('../lib/format');
const { pageHero, listCard, table } = require('../lib/views');
const { flash } = require('../lib/tenant-flash');
const { db: rawDb } = require('../lib/tenant');
const { operatorLayout } = require('../lib/operator-shell');
const { requireOperator, logPlatformEvent } = require('../lib/platform-operators');
const { refresh, emailAnnouncement } = require('../lib/announcements');

function page(res, opts) {
  return res.send(operatorLayout({ ...opts, operator: res.locals.operator, flash: res.locals.flash, flashType: res.locals.flashType }));
}
const when = (d) => (d ? new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC' : 'until ended');
// <input type="datetime-local"> values are read as UTC (Ghana's time zone).
const parseLocal = (v) => (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(v || '')) ? new Date(`${v}:00Z`) : null);
const toLocal = (d) => new Date(d).toISOString().slice(0, 16);

function state(a, now) {
  if (new Date(a.startsAt) > now) return ['scheduled', 'pending'];
  if (a.endsAt && new Date(a.endsAt) <= now) return ['ended', 'skipped'];
  return ['showing', 'sent'];
}

function register(app) {
  app.get('/platform/announcements', requireOperator, asyncHandler(async (req, res) => {
    const now = new Date();
    const list = await rawDb.platformAnnouncement.findMany({ orderBy: { startsAt: 'desc' }, take: 100 });
    const rows = list.map((a) => {
      const [label, tone] = state(a, now);
      return [
        `<span class="pill pill-${tone}">${label}</span>${a.level === 'warning' ? ' <span class="pill pill-failed">important</span>' : ''}`,
        `${esc(a.message)}${a.emailedAt ? `<small>Emailed to admins ${esc(when(a.emailedAt))}</small>` : ''}`,
        `${esc(when(a.startsAt))}<small>to ${esc(when(a.endsAt))}</small>`,
        `<div class="platform-actions">
          ${label !== 'ended' ? `<form method="post" action="/platform/announcements/${a.id}/end" class="inline platform-inline-form"><button type="submit" class="ghost">End now</button></form>` : ''}
          <form method="post" action="/platform/announcements/${a.id}/delete" class="inline platform-inline-form" data-confirm="Delete this announcement?"><button type="submit" class="link danger">Delete</button></form>
        </div>`,
      ];
    });
    const week = new Date(now.getTime() + 7 * 86400000);
    const body = `
      ${pageHero('Announcements', 'A notice at the top of every church’s app while it runs: maintenance, new features, holidays.')}
      <section class="card">
        <div class="card-head"><h2>New announcement</h2></div>
        <form class="form" method="post" action="/platform/announcements">
          <label class="wide">Message<textarea name="message" required maxlength="300" rows="2" placeholder="e.g. Church Manager will be unavailable on Saturday from 10pm to 11pm for maintenance."></textarea></label>
          <label>Shows from (UTC)<input type="datetime-local" name="startsAt" value="${toLocal(now)}" required></label>
          <label>Until (UTC)<input type="datetime-local" name="endsAt" value="${toLocal(week)}"><span class="hint">Empty: until you end it.</span></label>
          <label>Kind<select name="level"><option value="info">Information</option><option value="warning">Important</option></select></label>
          <label class="check"><input type="checkbox" name="email" value="1"> Also email it to every church's admins now</label>
          <div class="actions"><button type="submit">Publish</button></div>
        </form>
      </section>
      ${listCard({
        title: 'Announcements', count: list.length, countLabel: list.length === 1 ? 'announcement' : 'announcements',
        note: 'Churches see a notice within a minute of it starting, and can dismiss it on their device.',
        inner: rows.length ? table(['', 'Message', 'When', ''], rows, { keyCols: 2 }) : '<p class="muted-text">None yet.</p>',
      })}`;
    page(res, { title: 'Announcements', active: '/platform/announcements', body });
  }));

  app.post('/platform/announcements', requireOperator, asyncHandler(async (req, res) => {
    const b = req.body || {};
    const message = String(b.message || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    const startsAt = parseLocal(b.startsAt) || new Date();
    const endsAt = b.endsAt ? parseLocal(b.endsAt) : null;
    if (!message) { flash(req, 'Write the message.'); return res.redirect('/platform/announcements'); }
    if (b.endsAt && (!endsAt || endsAt <= startsAt)) { flash(req, 'The end must be after the start.'); return res.redirect('/platform/announcements'); }
    const operator = res.locals.operator;
    const created = await rawDb.platformAnnouncement.create({ data: { message, level: b.level === 'warning' ? 'warning' : 'info', startsAt, endsAt, createdBy: operator.email } });
    await refresh();
    await logPlatformEvent(req, { operator, event: 'platform.announcement_created', subject: message.slice(0, 200) });
    let note = '';
    if (b.email) {
      emailAnnouncement(created)
        .then((r) => console.log(`[announcements] #${created.id} emailed to ${r.sent} of ${r.recipients} admins`))
        .catch((e) => console.error('[announcements] email failed:', e.message));
      note = ' It is being emailed to every church\'s admins.';
    }
    flash(req, `Published.${note}`, 'success');
    res.redirect('/platform/announcements');
  }));

  app.post('/platform/announcements/:id/end', requireOperator, asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const a = Number.isInteger(id) ? await rawDb.platformAnnouncement.findUnique({ where: { id } }) : null;
    if (a) {
      await rawDb.platformAnnouncement.update({ where: { id }, data: { endsAt: new Date(), ...(new Date(a.startsAt) > new Date() ? { startsAt: new Date() } : {}) } });
      await refresh();
      await logPlatformEvent(req, { operator: res.locals.operator, event: 'platform.announcement_ended', subject: a.message.slice(0, 200) });
      flash(req, 'Ended. Churches stop seeing it within a minute.', 'success');
    }
    res.redirect('/platform/announcements');
  }));

  app.post('/platform/announcements/:id/delete', requireOperator, asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const a = Number.isInteger(id) ? await rawDb.platformAnnouncement.findUnique({ where: { id } }) : null;
    if (a) {
      await rawDb.platformAnnouncement.delete({ where: { id } });
      await refresh();
      await logPlatformEvent(req, { operator: res.locals.operator, event: 'platform.announcement_deleted', subject: a.message.slice(0, 200) });
      flash(req, 'Deleted.', 'success');
    }
    res.redirect('/platform/announcements');
  }));
}

module.exports = { register };
