'use strict';
// Phase 8c: HTML port of routes/events.js onto the Postgres stack.
// Registered ALONGSIDE routes-pg/events.js (JSON at /api/events, this is the
// bare-path HTML surface).
//
// Phase 9b added the public token-based self-service check-in
// (/checkin/:token) + RSVP (/rsvp/:token) flows, plus admin QR generation
// (/events/:id/qr) — see resolveChurchByCheckinToken() usage below and
// lib/tenant.js for the "resolve tenant from a bare token, no session"
// pattern (safe because Event.checkinToken is globally @unique).
//
// Still deferred: the calendar view (was never in routes-pg/events.js's
// scope either).

const crypto = require('crypto');
const QRCode = require('qrcode');
const asyncHandler = require('../lib/async-handler');
const { esc } = require('../lib/format');
const { pageHero, statsRow, filterCard, listCard, ICON_EYE, ICON_PENCIL } = require('../lib/views');
const { flash } = require('../lib/tenant-flash');
const { isLimited, requireEditorWithFullAccess } = require('../lib/access');
const { logActivity } = require('../lib/tenant-activity');
const { authPage } = require('../lib/tenant-shell');
const { resolveChurchByCheckinToken } = require('../lib/tenant');

// Public check-in and RSVP pages belong to one church: show its name.
const churchPage = (resolved, title, body) => authPage(title, body, undefined, { churchName: resolved.event.church.name });
const { icon } = require('../lib/icons');
const { getSessionSecret } = require('../lib/session-secret');
const { createRateLimiter } = require('../lib/rate-limit');

// ---- Public check-in / RSVP hardening -------------------------------------
// Possession of the QR token is the only credential on these pages, and the
// QR is printed in the building. Without the guards below, anyone holding it
// could walk member ids 1..N to read every name (the response greets the
// member) and mark everyone present, or open the RSVP page and read the whole
// roster from its dropdown.
//  - a name must be searched for (min 3 chars, capped results) and the
//    resulting "pick" is HMAC-signed, so a bare memberId cannot be posted;
//  - the pages are rate limited per client and token.
const MIN_PUBLIC_QUERY = 3;
const publicRateLimit = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  max: 60,
  key: (req) => `${req.ip}|${req.params.token}`,
});

function pickSig(token, memberId) {
  return crypto.createHmac('sha256', getSessionSecret()).update(`pick:${token}:${memberId}`).digest('hex').slice(0, 32);
}
function pickSigValid(token, memberId, sig) {
  const expected = Buffer.from(pickSig(token, memberId));
  const given = Buffer.from(String(sig || ''));
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}
function memberSearchWhere(q) {
  const words = q.split(/\s+/).filter(Boolean);
  const fullNameMatch = words.length >= 2
    ? [{ AND: [{ firstName: { contains: words[0], mode: 'insensitive' } }, { lastName: { contains: words.slice(1).join(' '), mode: 'insensitive' } }] }]
    : [];
  return [
    { externalId: q.toUpperCase() },
    { firstName: { contains: q, mode: 'insensitive' } },
    { lastName: { contains: q, mode: 'insensitive' } },
    { mobilePhone: { contains: q } },
    ...fullNameMatch,
  ];
}

const EVENT_TYPES = ['SERVICE', 'PRAYER', 'BIBLE_STUDY', 'OUTREACH', 'YOUTH', 'WEDDING', 'FUNERAL', 'BAPTISM', 'CONFIRMATION', 'OTHER'];
const RSVP_RESPONSES = ['GOING', 'MAYBE', 'NO'];
const RSVP_LABELS = { GOING: 'Going', MAYBE: 'Maybe', NO: "Can't" };
const RSVP_PILL_CLASS = { GOING: 'pill-member', MAYBE: 'pill-visitor', NO: 'pill-inactive' };

function requireAdmin(req, res, next) {
  if (res.locals.user && res.locals.user.role === 'ADMIN') return next();
  return res.status(403).send('Forbidden');
}
// Editors can add and edit; deleting, archiving and anything that sends
// messages stays with admins.
function requireEditor(req, res, next) {
  if (res.locals.user && ['ADMIN', 'EDITOR'].includes(res.locals.user.role)) return next();
  return res.status(403).send('Forbidden');
}

function iso(d) {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d);
  return isNaN(dt) ? '' : dt.toISOString().slice(0, 16);
}
function fmtDt(d) { return iso(d).replace('T', ' '); }

// Attendance/RSVP routes only carry ids, but an audit line naming "member #47"
// is close to useless — resolve through the tenant-scoped client (so a foreign
// id can never be named) and fall back to the id if it does not resolve.
// Both ids come from the form: confirm they are this church's before linking
// them (the scoped db limits what is read, not what a new row points at).
async function eventAndMemberInChurch(db, eventId, memberId) {
  if (!Number.isInteger(eventId) || !Number.isInteger(memberId)) return false;
  const [event, member] = await Promise.all([
    db.event.findUnique({ where: { id: eventId }, select: { id: true } }),
    db.member.findUnique({ where: { id: memberId }, select: { id: true } }),
  ]);
  return Boolean(event && member);
}

async function memberLabel(db, memberId) {
  const m = await db.member.findUnique({ where: { id: memberId } });
  return m ? `${m.firstName} ${m.lastName}` : `member #${memberId}`;
}

function toIntOrNull(v) {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

function parseEventBody(b) {
  return {
    title: (b.title || '').trim(),
    eventType: EVENT_TYPES.includes(b.eventType) ? b.eventType : 'SERVICE',
    startsAt: b.startsAt ? new Date(b.startsAt) : null,
    endsAt: b.endsAt ? new Date(b.endsAt) : null,
    location: (b.location || '').trim() || null,
    notes: (b.notes || '').trim() || null,
  };
}

function eventForm(ev, action) {
  const e = ev || {};
  return `<form class="form" method="post" action="${action}">
    <label>Title<input name="title" required value="${esc(e.title || '')}"></label>
    <label>Type<select name="eventType">
      ${EVENT_TYPES.map((t) => `<option value="${t}" ${t === (e.eventType || 'SERVICE') ? 'selected' : ''}>${t}</option>`).join('')}
    </select></label>
    <label>Starts<input type="datetime-local" name="startsAt" required value="${esc(iso(e.startsAt))}"></label>
    <label>Ends<input type="datetime-local" name="endsAt" value="${esc(iso(e.endsAt))}"></label>
    <label>Location<input name="location" value="${esc(e.location || '')}"></label>
    <label class="wide">Notes<textarea name="notes" rows="2">${esc(e.notes || '')}</textarea></label>
    <div class="actions form-actions">
      <a class="btn ghost" href="${e.id ? `/events/${e.id}` : '/events'}">Cancel</a>
      <button type="submit">${e.id ? 'Save changes' : 'Save event'}</button>
    </div>
  </form>`;
}

function register(app) {
  app.get('/events', asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    const db = res.locals.db;
    const isAdmin = res.locals.user.role === 'ADMIN';
    // Editors without finance access read events but may still check people in.
    const canCheckIn = isAdmin || res.locals.user.role === 'EDITOR';
    const canEdit = canCheckIn && !isLimited(res.locals.user);
    const q = (req.query.q || '').trim();

    const [rows, totalEvents, upcoming, checkins] = await Promise.all([
      db.event.findMany({
        where: q ? { title: { contains: q, mode: 'insensitive' } } : {},
        orderBy: { startsAt: 'desc' },
        include: { _count: { select: { attendance: true } } },
      }),
      db.event.count(),
      db.event.count({ where: { startsAt: { gte: new Date() } } }),
      db.attendance.count(),
    ]);

    const hero = pageHero('Events', 'Services, meetings and special events — schedule them and track attendance.');
    const stats = statsRow([
      { cls: 'gold', icon: icon('events'), value: totalEvents.toLocaleString(), label: 'Total Events' },
      { cls: 'green', icon: icon('clock'), value: upcoming.toLocaleString(), label: 'Upcoming' },
      { cls: 'blue', icon: icon('attendance'), value: checkins.toLocaleString(), label: 'Check-ins Recorded' },
    ], canEdit ? `<a class="btn primary" href="/events/new">＋ New Event</a>` : '');
    const filters = filterCard({ q, placeholder: 'Search events by title…' });

    const rowHtml = rows.map((r) => {
      const when = r.startsAt.toLocaleString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
      return `<tr>
        <td data-label="When">${esc(when)}</td>
        <td data-label="Event">
          <div><span class="evt-type">${esc(r.eventType)}</span></div>
          <a class="m-name" href="/events/${r.id}">${esc(r.title)}</a>
        </td>
        <td data-label="Location">${esc(r.location) || '<span class="muted-text">—</span>'}</td>
        <td data-label="Attendees"><span class="count-badge">${r._count.attendance}</span></td>
        <td data-label="Actions"><div class="row-actions">
          <a class="icon-btn view" href="/events/${r.id}" title="View" aria-label="View">${ICON_EYE}</a>
          ${canEdit ? `<a class="icon-btn edit" href="/events/${r.id}/edit" title="Edit" aria-label="Edit">${ICON_PENCIL}</a>` : ''}
        </div></td>
      </tr>`;
    }).join('');

    const list = listCard({
      title: 'Events', count: rows.length, countLabel: 'events',
      inner: rows.length ? `<table class="data-table members-table">
          <thead><tr><th>When</th><th>Event</th><th>Location</th><th>Attendees</th><th>Actions</th></tr></thead>
          <tbody>${rowHtml}</tbody>
        </table>` : `<div class="empty-state">
          <div class="empty-ico" aria-hidden="true">📅</div>
          <h3>${q ? `No events match "${esc(q)}"` : 'No events scheduled yet'}</h3>
          <p>${q ? 'Try a different search term, or schedule a new event.' : 'Add your first event and it will appear here.'}</p>
          ${canEdit ? '<a class="btn primary" href="/events/new">＋ New Event</a>' : ''}
          ${q ? '<div style="margin-top:0.6rem"><a class="link" href="/events">Clear search →</a></div>' : ''}
        </div>`,
    });

    res.page({ title: 'Events', active: '/events', noHeader: true, body: `${hero}${stats}${filters}${list}` });
  }));

  app.get('/events/new', requireEditorWithFullAccess, (req, res) => {
    res.page({ title: 'New event', active: '/events', noHeader: true, body: `${pageHero('New event', '')}${eventForm(null, '/events')}` });
  });

  app.get('/events/:id/edit', requireEditorWithFullAccess, asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const ev = await res.locals.db.event.findUnique({ where: { id } });
    if (!ev) return res.status(404).send('Not found');
    res.page({
      title: `Edit · ${ev.title}`, active: '/events', noHeader: true,
      body: `${pageHero(`Edit · ${ev.title}`, '')}<p><a href="/events/${id}">← Back to event</a></p>${eventForm(ev, `/events/${id}/edit`)}`,
    });
  }));

  app.post('/events/:id/edit', requireEditorWithFullAccess, asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const v = parseEventBody(req.body || {});
    if (!v.title || !v.startsAt || Number.isNaN(v.startsAt.getTime())) {
      flash(req, 'Title and start time are required.');
      return res.redirect(`/events/${id}/edit`);
    }
    if (v.endsAt && (Number.isNaN(v.endsAt.getTime()) || v.endsAt < v.startsAt)) {
      flash(req, 'The end time must be a valid time after the start.');
      return res.redirect(`/events/${id}/edit`);
    }
    try {
      await res.locals.db.event.update({ where: { id }, data: v });
    } catch (e) {
      if (e.code !== 'P2025') throw e;
      return res.status(404).send('Not found');
    }
    await logActivity(res.locals.db, 'event_updated', `Event updated: ${v.title}`, `/events/${id}`, res.locals.user.id);
    flash(req, 'Event updated.', 'success');
    res.redirect(`/events/${id}`);
  }));

  app.post('/events', requireEditorWithFullAccess, asyncHandler(async (req, res) => {
    const v = parseEventBody(req.body || {});
    if (!v.title || !v.startsAt || Number.isNaN(v.startsAt.getTime())) {
      flash(req, 'Title and start time are required.');
      return res.redirect('/events/new');
    }
    if (v.endsAt && (Number.isNaN(v.endsAt.getTime()) || v.endsAt < v.startsAt)) {
      flash(req, 'The end time must be a valid time after the start.');
      return res.redirect('/events/new');
    }
    const ev = await res.locals.db.event.create({ data: { ...v, checkinToken: crypto.randomBytes(16).toString('hex') } });
    await logActivity(res.locals.db, 'event_created', `Event scheduled: ${v.title}`, `/events/${ev.id}`, res.locals.user.id);
    res.redirect(`/events/${ev.id}`);
  }));

  app.get('/events/:id', asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    const db = res.locals.db;
    const isAdmin = res.locals.user.role === 'ADMIN';
    // Editors without finance access read events but may still check people in.
    const canCheckIn = isAdmin || res.locals.user.role === 'EDITOR';
    const canEdit = canCheckIn && !isLimited(res.locals.user);
    const id = Number(req.params.id);
    const ev = await db.event.findUnique({ where: { id } });
    if (!ev) return res.status(404).send('Not found');

    const [attendees, others, rsvps] = await Promise.all([
      db.attendance.findMany({
        where: { eventId: id }, include: { member: { select: { id: true, firstName: true, lastName: true } } },
        orderBy: { member: { lastName: 'asc' } },
      }),
      db.member.findMany({
        where: { deletedAt: null, membershipStatus: { in: ['MEMBER', 'REGULAR', 'VISITOR'] }, attendance: { none: { eventId: id } } },
        orderBy: { lastName: 'asc' }, select: { id: true, firstName: true, lastName: true },
      }),
      db.eventRsvp.findMany({
        where: { eventId: id }, include: { member: { select: { id: true, firstName: true, lastName: true } } },
        orderBy: [{ response: 'asc' }, { member: { lastName: 'asc' } }],
      }),
    ]);

    const removeForm = (mid) => canCheckIn
      ? `<form method="post" action="/events/${id}/uncheck">
           <input type="hidden" name="memberId" value="${mid}">
           <button class="link" type="submit">remove</button>
         </form>` : '';
    const attendList = attendees.length
      ? `<ul class="check-list">${attendees.map((a) => `<li><a href="/members/${a.member.id}">${esc(a.member.firstName + ' ' + a.member.lastName)}</a>${removeForm(a.member.id)}</li>`).join('')}</ul>`
      : '<p>No one checked in yet.</p>';

    const otherOpts = others.map((o) => `<option value="${o.id}">${esc(o.firstName + ' ' + o.lastName)}</option>`).join('');
    const checkInPanel = canCheckIn
      ? `<h2>Check in</h2>
         <form method="post" action="/events/${id}/check">
           <select name="memberId" required><option value="">— pick a member —</option>${otherOpts}</select>
           <button type="submit">Check in</button>
         </form>
         <p><a class="btn" href="/events/${id}/qr">📱 QR check-in page</a>
            <a class="btn ghost" href="/checkin/${esc(ev.checkinToken || '')}" target="_blank" rel="noopener">Preview self-check-in</a></p>` : '';

    const rsvpLink = canCheckIn
      ? `<p class="muted-text" style="margin-top:0.4rem">Public RSVP link:
         <a href="/rsvp/${esc(ev.checkinToken || '')}" target="_blank" rel="noopener">/rsvp/${esc(ev.checkinToken || '')}</a></p>`
      : '';

    const rsvpCounts = { GOING: 0, MAYBE: 0, NO: 0 };
    for (const r of rsvps) rsvpCounts[r.response] = (rsvpCounts[r.response] || 0) + 1;
    const rsvpList = rsvps.length
      ? `<ul class="check-list">${rsvps.map((r) => `<li>
          <a href="/members/${r.member.id}">${esc(r.member.firstName + ' ' + r.member.lastName)}</a>
          <span class="pill ${RSVP_PILL_CLASS[r.response]}">${RSVP_LABELS[r.response]}</span>
          ${canCheckIn ? `<form method="post" action="/events/${id}/rsvp/remove">
            <input type="hidden" name="memberId" value="${r.member.id}">
            <button class="link" type="submit">remove</button></form>` : ''}
        </li>`).join('')}</ul>`
      : '<p class="muted-text">No responses yet.</p>';
    const rsvpAdmin = canCheckIn
      ? `<form method="post" action="/events/${id}/rsvp" class="filter-bar" style="margin-top:0.6rem">
           <select name="memberId" required style="flex:1;min-width:180px"><option value="">— pick a member —</option>${otherOpts}</select>
           <select name="response">${RSVP_RESPONSES.map((v) => `<option value="${v}">${RSVP_LABELS[v]}</option>`).join('')}</select>
           <button type="submit">Save RSVP</button>
         </form>` : '';

    const men = ev.attendanceMen ?? '';
    const women = ev.attendanceWomen ?? '';
    const children = ev.attendanceChildren ?? '';
    const totalEntered = ev.attendanceTotal ?? '';
    const hasCounts = (men !== '' || women !== '' || children !== '' || totalEntered !== '');
    const countsCard = `
      <div class="card attendance-counts-card" style="margin-bottom:1rem">
        <div class="card-head">
          <div><h2>Attendance counts</h2><div class="meta">Head-count for the service · editable</div></div>
          ${hasCounts ? `<span class="pill pill-ok">⚬ Recorded</span>` : ''}
        </div>
        ${canEdit ? `<form method="post" action="/events/${id}/counts" class="counts-form" data-no-confirm="1">
          <label class="counts-field"><span>Men</span><input type="number" name="attendanceMen" min="0" step="1" value="${esc(men)}"></label>
          <label class="counts-field"><span>Women</span><input type="number" name="attendanceWomen" min="0" step="1" value="${esc(women)}"></label>
          <label class="counts-field"><span>Children</span><input type="number" name="attendanceChildren" min="0" step="1" value="${esc(children)}"></label>
          <label class="counts-field counts-total"><span>Total</span><input type="number" name="attendanceTotal" min="0" step="1" value="${esc(totalEntered)}" placeholder="auto"></label>
          <div class="counts-actions">
            <button class="btn primary" type="submit">${hasCounts ? 'Update counts' : 'Save counts'}</button>
            ${hasCounts ? `<button class="btn ghost" type="submit" name="clear" value="1" formnovalidate>Clear</button>` : ''}
          </div>
          <p class="muted-text counts-hint">Leave Total blank and we'll add Men + Women + Children for you.</p>
        </form>` : `<dl class="counts-readonly">
          <div><dt>Men</dt><dd>${men === '' ? '—' : esc(men)}</dd></div>
          <div><dt>Women</dt><dd>${women === '' ? '—' : esc(women)}</dd></div>
          <div><dt>Children</dt><dd>${children === '' ? '—' : esc(children)}</dd></div>
          <div><dt>Total</dt><dd>${totalEntered === '' ? '—' : esc(totalEntered)}</dd></div>
        </dl>`}
      </div>`;

    const body = `
      <div class="event-detail-head">
        <div>
          <div class="evt-type">${esc(ev.eventType)}</div>
          <div class="event-detail-meta">${esc(fmtDt(ev.startsAt))}${ev.location ? ` · ${esc(ev.location)}` : ''}</div>
        </div>
        ${canEdit ? `<a class="btn primary" href="/events/${id}/edit">✎ Edit event</a>` : ''}
      </div>
      ${countsCard}
      <div class="card" style="margin-bottom:1rem">
        <div class="card-head"><h2>RSVPs</h2>
          <span class="meta">✅ ${rsvpCounts.GOING} going · 🤔 ${rsvpCounts.MAYBE} maybe · ✖ ${rsvpCounts.NO} can't</span></div>
        ${rsvpList}
        ${rsvpAdmin}
        ${rsvpLink}
      </div>
      <div class="two-col">
        <section>
          <h2>Attendees (${attendees.length})</h2>
          ${attendList}
        </section>
        <section>
          ${checkInPanel}
          ${ev.notes ? `<h3>Notes</h3><p>${esc(ev.notes)}</p>` : ''}
        </section>
      </div>`;
    res.page({ title: ev.title, active: '/events', noHeader: true, body: `${pageHero(ev.title, '')}${body}` });
  }));

  app.post('/events/:id/counts', requireEditorWithFullAccess, asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const ev = await res.locals.db.event.findUnique({ where: { id } });
    if (!ev) return res.status(404).send('Not found');
    if (req.body.clear === '1') {
      await res.locals.db.event.update({ where: { id }, data: { attendanceMen: null, attendanceWomen: null, attendanceChildren: null, attendanceTotal: null } });
      flash(req, 'Attendance counts cleared.', 'success');
      return res.redirect(`/events/${id}`);
    }
    const men = toIntOrNull(req.body.attendanceMen);
    const women = toIntOrNull(req.body.attendanceWomen);
    const children = toIntOrNull(req.body.attendanceChildren);
    let total = toIntOrNull(req.body.attendanceTotal);
    if (total === null && (men !== null || women !== null || children !== null)) total = (men || 0) + (women || 0) + (children || 0);
    await res.locals.db.event.update({ where: { id }, data: { attendanceMen: men, attendanceWomen: women, attendanceChildren: children, attendanceTotal: total } });
    await logActivity(res.locals.db, 'attendance_recorded', `Counts saved · M:${men ?? '—'} W:${women ?? '—'} C:${children ?? '—'} Total:${total ?? '—'}`, `/events/${id}`, res.locals.user.id);
    flash(req, 'Attendance counts saved.', 'success');
    res.redirect(`/events/${id}`);
  }));

  app.post('/events/:id/rsvp', requireEditor, asyncHandler(async (req, res) => {
    const eventId = Number(req.params.id);
    const memberId = Number(req.body.memberId);
    const response = RSVP_RESPONSES.includes(req.body.response) ? req.body.response : 'GOING';
    if (memberId) {
      if (!(await eventAndMemberInChurch(res.locals.db, eventId, memberId))) { flash(req, 'Member not found.'); return res.redirect(`/events/${eventId}`); }
      await res.locals.db.eventRsvp.upsert({
        where: { eventId_memberId: { eventId, memberId } },
        update: { response, respondedAt: new Date() },
        create: { eventId, memberId, response },
      });
      await logActivity(res.locals.db, 'event_rsvp_recorded',
        `RSVP ${response} recorded for ${await memberLabel(res.locals.db, memberId)}`, `/events/${eventId}`, res.locals.user.id);
    }
    res.redirect(`/events/${eventId}`);
  }));

  app.post('/events/:id/rsvp/remove', requireEditor, asyncHandler(async (req, res) => {
    const eventId = Number(req.params.id);
    const memberId = Number(req.body.memberId);
    try {
      await res.locals.db.eventRsvp.delete({ where: { eventId_memberId: { eventId, memberId } } });
      await logActivity(res.locals.db, 'event_rsvp_removed',
        `RSVP removed for ${await memberLabel(res.locals.db, memberId)}`, `/events/${eventId}`, res.locals.user.id);
    } catch (e) {
      if (e.code !== 'P2025') throw e;
    }
    res.redirect(`/events/${eventId}`);
  }));

  app.post('/events/:id/check', requireEditor, asyncHandler(async (req, res) => {
    const eventId = Number(req.params.id);
    const memberId = Number(req.body.memberId);
    if (memberId) {
      if (!(await eventAndMemberInChurch(res.locals.db, eventId, memberId))) { flash(req, 'Member not found.'); return res.redirect(`/events/${eventId}`); }
      await res.locals.db.attendance.upsert({ where: { eventId_memberId: { eventId, memberId } }, update: {}, create: { eventId, memberId } });
      await logActivity(res.locals.db, 'attendance_recorded',
        `${await memberLabel(res.locals.db, memberId)} checked in`, `/events/${eventId}`, res.locals.user.id);
    }
    res.redirect(`/events/${eventId}`);
  }));

  app.post('/events/:id/uncheck', requireEditor, asyncHandler(async (req, res) => {
    const eventId = Number(req.params.id);
    const memberId = Number(req.body.memberId);
    try {
      await res.locals.db.attendance.delete({ where: { eventId_memberId: { eventId, memberId } } });
      await logActivity(res.locals.db, 'attendance_removed',
        `${await memberLabel(res.locals.db, memberId)} checked out`, `/events/${eventId}`, res.locals.user.id);
    } catch (e) {
      if (e.code !== 'P2025') throw e;
    }
    res.redirect(`/events/${eventId}`);
  }));

  // ---------- QR check-in (admin display) ----------
  app.get('/events/:id/qr', requireEditor, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const id = Number(req.params.id);
    let ev = await db.event.findUnique({ where: { id } });
    if (!ev) return res.status(404).send('Not found');
    if (!ev.checkinToken) {
      ev = await db.event.update({ where: { id }, data: { checkinToken: crypto.randomBytes(16).toString('hex') } });
    }
    const baseUrl = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
    const url = `${baseUrl}/checkin/${ev.checkinToken}`;
    let qrSvg;
    try {
      qrSvg = await QRCode.toString(url, { type: 'svg', width: 400, margin: 2, errorCorrectionLevel: 'M' });
    } catch (e) {
      return res.status(500).send('QR generation failed: ' + e.message);
    }
    const when = new Date(ev.startsAt).toLocaleString('en-GB', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });

    const body = `
      <p><a href="/events/${id}">← Back to event</a></p>
      <div class="qr-page">
        <div class="qr-card">
          <div class="qr-meta">
            <h2>${esc(ev.title)}</h2>
            <p>${esc(when)}</p>
            ${ev.location ? `<p class="muted-text">${esc(ev.location)}</p>` : ''}
          </div>
          <div class="qr-art">${qrSvg}</div>
          <p class="qr-instruct"><strong>Scan with your phone camera</strong> to check in.</p>
          <p class="qr-url muted-text">${esc(url)}</p>
        </div>
        <div class="qr-actions screen-only">
          <button onclick="window.print()">🖨 Print this QR sign</button>
        </div>
      </div>`;
    res.page({ title: `Check-in QR · ${ev.title}`, active: '/events', body });
  }));

  // ---------- Public self-service check-in (no session) ----------
  app.get('/checkin/:token', publicRateLimit, asyncHandler(async (req, res) => {
    const resolved = await resolveChurchByCheckinToken(req.params.token);
    if (!resolved) {
      return res.status(404).send(authPage('Check-in link not recognized', '<p>This check-in QR is no longer valid. Please ask an usher for help.</p>'));
    }
    const { event: ev } = resolved;
    const when = new Date(ev.startsAt).toLocaleString('en-GB', { weekday: 'long', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    res.send(churchPage(resolved, `Check in · ${ev.title}`, `
      <p class="muted-text">${esc(when)}${ev.location ? ' · ' + esc(ev.location) : ''}</p>
      <form method="post" action="/checkin/${esc(req.params.token)}" class="form auth-form">
        <label class="wide">Your name or Member ID
          <input name="q" required minlength="${MIN_PUBLIC_QUERY}" autofocus placeholder="e.g. John Anderson or MBR-001">
        </label>
        <div class="actions"><button type="submit">Find me →</button></div>
      </form>`));
  }));

  app.post('/checkin/:token', publicRateLimit, asyncHandler(async (req, res) => {
    const resolved = await resolveChurchByCheckinToken(req.params.token);
    if (!resolved) {
      return res.status(404).send(authPage('Check-in link not recognized', '<p>This check-in QR is no longer valid.</p>'));
    }
    const { event: ev, db } = resolved;

    const confirmedCheckin = async (m) => {
      await db.attendance.upsert({ where: { eventId_memberId: { eventId: ev.id, memberId: m.id } }, update: {}, create: { eventId: ev.id, memberId: m.id } });
      await logActivity(db, 'attendance_recorded', `${m.firstName} ${m.lastName} self-checked in to ${ev.title}`, `/events/${ev.id}`, null);
      return res.send(churchPage(resolved, `✓ Checked in, ${m.firstName}`, `
        <p style="font-size:1.1rem">Welcome, <strong>${esc(m.firstName)} ${esc(m.lastName)}</strong>.</p>
        <p>You're checked in to <strong>${esc(ev.title)}</strong>. Have a blessed time. 🙏</p>
        <p style="margin-top:1.25rem"><a href="/checkin/${esc(req.params.token)}">Check in another person</a></p>`));
    };

    if (req.body.memberId) {
      // Only a pick handed out by a search result is accepted — a bare,
      // guessed memberId must not check anyone in or reveal their name.
      const memberId = Number(req.body.memberId);
      if (!pickSigValid(req.params.token, memberId, req.body.sig)) return res.redirect(`/checkin/${req.params.token}`);
      const m = await db.member.findFirst({ where: { id: memberId, deletedAt: null } });
      if (!m) return res.redirect(`/checkin/${req.params.token}`);
      return confirmedCheckin(m);
    }

    const q = String(req.body.q || '').trim();
    if (q.length < MIN_PUBLIC_QUERY) return res.redirect(`/checkin/${req.params.token}`);
    const matches = await db.member.findMany({
      where: { deletedAt: null, OR: memberSearchWhere(q) },
      include: { bibleClass: { select: { name: true } }, attendance: { where: { eventId: ev.id }, select: { eventId: true } } },
      orderBy: { lastName: 'asc' },
      take: 12,
    });

    if (matches.length === 0) {
      return res.send(churchPage(resolved, 'No match found', `
        <p>No member found for <strong>"${esc(q)}"</strong>. Please ask an usher for help, or try a different spelling / your Member ID (e.g. MBR-007).</p>
        <p><a href="/checkin/${esc(req.params.token)}">← Try again</a></p>`));
    }

    if (matches.length === 1 && matches[0].attendance.length === 0) {
      return confirmedCheckin(matches[0]);
    }

    const list = matches.map((m) => `
      <form method="post" action="/checkin/${esc(req.params.token)}" class="checkin-pick">
        <input type="hidden" name="memberId" value="${m.id}">
        <input type="hidden" name="sig" value="${pickSig(req.params.token, m.id)}">
        <button type="submit" ${m.attendance.length ? 'disabled' : ''}>
          <div class="who">
            <div class="name">${esc(m.firstName)} ${esc(m.lastName)}</div>
            <div class="meta">${esc(m.externalId) || ''}${m.bibleClass ? ' · ' + esc(m.bibleClass.name) : ''}</div>
          </div>
          <span class="pick-tag">${m.attendance.length ? '✓ already checked in' : 'Tap to check in'}</span>
        </button>
      </form>`).join('');

    res.send(churchPage(resolved, matches.length === 1 ? 'Already checked in' : 'Pick your name', `
      <p class="muted-text">${matches.length} match${matches.length === 1 ? '' : 'es'} for "${esc(q)}":</p>
      ${list}
      <p style="margin-top:1rem"><a href="/checkin/${esc(req.params.token)}">← Search again</a></p>`));
  }));

  // ---------- Public self-service RSVP (no session) ----------
  // Same search-then-pick flow as check-in: the page never lists the roster.
  app.get('/rsvp/:token', publicRateLimit, asyncHandler(async (req, res) => {
    const resolved = await resolveChurchByCheckinToken(req.params.token);
    if (!resolved) {
      return res.status(404).send(authPage('RSVP link not recognized', '<p>This RSVP link is not valid.</p>'));
    }
    const { event: ev } = resolved;
    const done = req.query.ok === '1';
    res.send(churchPage(resolved, `RSVP · ${ev.title}`, `
      <p class="muted">${esc(ev.eventType)} · ${esc(fmtDt(ev.startsAt))}${ev.location ? ` · ${esc(ev.location)}` : ''}</p>
      ${done ? '<div class="flash flash-success">Thank you — your response has been recorded.</div>' : ''}
      <form class="form auth-form" method="post" action="/rsvp/${esc(req.params.token)}">
        <label class="wide">Your name or Member ID<input name="q" required minlength="${MIN_PUBLIC_QUERY}" placeholder="e.g. John Anderson or MBR-001"></label>
        <label class="wide">Will you attend?
          <select name="response"><option value="GOING">Yes, I'll be there</option><option value="MAYBE">Maybe</option><option value="NO">Can't make it</option></select></label>
        <div class="actions"><button type="submit">Find me →</button></div>
      </form>`));
  }));

  app.post('/rsvp/:token', publicRateLimit, asyncHandler(async (req, res) => {
    const resolved = await resolveChurchByCheckinToken(req.params.token);
    if (!resolved) return res.status(404).send('Not found');
    const { event: ev, db } = resolved;
    const response = RSVP_RESPONSES.includes(req.body.response) ? req.body.response : 'GOING';
    const statusFilter = { in: ['MEMBER', 'REGULAR', 'VISITOR'] };

    if (req.body.memberId) {
      const memberId = Number(req.body.memberId);
      if (!pickSigValid(req.params.token, memberId, req.body.sig)) return res.redirect(`/rsvp/${req.params.token}`);
      // Signed, but still confirm it belongs to this church (db is tenant-scoped).
      const m = await db.member.findFirst({ where: { id: memberId, deletedAt: null } });
      if (m) {
        await db.eventRsvp.upsert({
          where: { eventId_memberId: { eventId: ev.id, memberId } },
          update: { response, respondedAt: new Date() },
          create: { eventId: ev.id, memberId, response },
        });
        // Public form: no session, so no actor — null, exactly as the public
        // self-check-in above records it.
        await logActivity(db, 'event_rsvp_recorded',
          `${m.firstName} ${m.lastName} self-RSVPed ${response} to ${ev.title}`, `/events/${ev.id}`, null);
      }
      return res.redirect(`/rsvp/${req.params.token}?ok=1`);
    }

    const q = String(req.body.q || '').trim();
    if (q.length < MIN_PUBLIC_QUERY) return res.redirect(`/rsvp/${req.params.token}`);
    const matches = await db.member.findMany({
      where: { deletedAt: null, membershipStatus: statusFilter, OR: memberSearchWhere(q) },
      orderBy: { lastName: 'asc' }, take: 12, select: { id: true, firstName: true, lastName: true, externalId: true },
    });
    if (matches.length === 0) {
      return res.send(churchPage(resolved, 'No match found', `
        <p>No member found for <strong>"${esc(q)}"</strong>. Try a different spelling or your Member ID.</p>
        <p><a href="/rsvp/${esc(req.params.token)}">← Try again</a></p>`));
    }
    const list = matches.map((m) => `
      <form method="post" action="/rsvp/${esc(req.params.token)}" class="checkin-pick">
        <input type="hidden" name="memberId" value="${m.id}">
        <input type="hidden" name="sig" value="${pickSig(req.params.token, m.id)}">
        <input type="hidden" name="response" value="${esc(response)}">
        <button type="submit"><div class="who"><div class="name">${esc(m.firstName)} ${esc(m.lastName)}</div>
          <div class="meta">${esc(m.externalId) || ''}</div></div><span class="pick-tag">Tap to send RSVP</span></button>
      </form>`).join('');
    res.send(churchPage(resolved, 'Pick your name', `
      <p class="muted-text">${matches.length} match${matches.length === 1 ? '' : 'es'} for "${esc(q)}":</p>
      ${list}
      <p style="margin-top:1rem"><a href="/rsvp/${esc(req.params.token)}">← Search again</a></p>`));
  }));
}

module.exports = { register };
