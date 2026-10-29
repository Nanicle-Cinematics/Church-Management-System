'use strict';
// Phase 8c: HTML port of routes/attendance.js onto the Postgres stack.
// Registered ALONGSIDE routes-pg/attendance.js (JSON at /api/attendance,
// this is the bare-path HTML surface) — see the Phase 8 plan's recipe.
// Role model: admin-only writes, matching routes-pg/attendance.js.
//
// The original's CSV export (/attendance.csv) is NOT ported — same
// deferral routes-pg/attendance.js's own header comment already made.

const crypto = require('crypto');
const asyncHandler = require('../lib/async-handler');
const { esc } = require('../lib/format');
const { pageHero, statsRow, listCard, table } = require('../lib/views');
const { sparkline } = require('../lib/charts');
const { flash } = require('../lib/tenant-flash');
const { logActivity } = require('../lib/tenant-activity');
const { icon } = require('../lib/icons');
const { choiceField, readChoice } = require('../lib/choice');
const { serviceNames } = require('../lib/choice-lists');

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

function toIntOrNull(v) {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

function deriveTotal(men, women, children, total) {
  if (total !== null) return total;
  if (men === null && women === null && children === null) return null;
  return (men || 0) + (women || 0) + (children || 0);
}

const DAY_BORNS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
const dayLabel = (d) => d.charAt(0) + d.slice(1).toLowerCase();

const dayKey = (d) => `dayborn_${d}`;
const orgKey = (o) => `org_${o.id}`;

// Counts typed under "By day-born" / "By organization": one row per box that was filled in.
// Only this church's own organizations are read, so a made-up id in the form is ignored.
function parseGroupCounts(b, orgs) {
  const rows = [];
  for (const d of DAY_BORNS) { const n = toIntOrNull(b[dayKey(d)]); if (n !== null) rows.push({ dayBorn: d, count: n }); }
  for (const o of orgs) { const n = toIntOrNull(b[orgKey(o)]); if (n !== null) rows.push({ orgId: o.id, count: n }); }
  return rows;
}

async function saveGroupCounts(db, eventId, rows) {
  await db.eventGroupAttendance.deleteMany({ where: { eventId } });
  if (rows.length) await db.eventGroupAttendance.createMany({ data: rows.map((r) => ({ eventId, ...r })) });
}

const loadOrgs = (db) => db.organization.findMany({ where: { active: true }, orderBy: { name: 'asc' }, select: { id: true, name: true } });

function groupLabel(s) {
  if (s.attendanceDayBorn) return `${dayLabel(s.attendanceDayBorn)}-born`;
  if (s.attendanceOrg) return s.attendanceOrg.name;
  return null;
}

function parseServiceBody(b) {
  const men = toIntOrNull(b.attendanceMen);
  const women = toIntOrNull(b.attendanceWomen);
  const children = toIntOrNull(b.attendanceChildren);
  const total = deriveTotal(men, women, children, toIntOrNull(b.attendanceTotal));
  return {
    title: readChoice(b, 'title'),
    startsAt: b.startsAt ? new Date(b.startsAt) : null,
    location: (b.location || '').trim() || null,
    notes: (b.notes || '').trim() || null,
    attendanceMen: men, attendanceWomen: women, attendanceChildren: children, attendanceTotal: total,
  };
}

// Prisma DateTime -> the local "YYYY-MM-DDTHH:mm" <input type=datetime-local> expects.
function isoLocal(d) {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d);
  return isNaN(dt) ? '' : dt.toISOString().slice(0, 16);
}

function serviceForm(ev, action, opts = {}) {
  const e = ev || {};
  const isEdit = !!e.id;
  const orgs = opts.orgs || [];
  const gc = opts.groupCounts || new Map();
  const groupField = (name, label, key) => `<label class="counts-field"><span>${esc(label)}</span>
          <input type="number" name="${esc(name)}" min="0" step="1" value="${esc(gc.get(key) ?? '')}"></label>`;
  return `<form class="form attendance-service-form" method="post" action="${action}">
    ${choiceField({ name: 'title', label: 'Service title', options: opts.services || [], value: e.title || '', required: true, noneLabel: '— choose the service —', otherPlaceholder: 'e.g. Easter Sunrise Service', wide: true })}
    <label>
      <span>Date &amp; time <span class="req-star">*</span></span>
      <input type="datetime-local" name="startsAt" required value="${esc(isoLocal(e.startsAt))}">
    </label>
    <label>
      <span>Location</span>
      <input name="location" value="${esc(e.location || '')}" placeholder="e.g. Sanctuary">
    </label>
    <div class="wide-cell">
      <h3 class="form-section">Attendance counts</h3>
      <p class="muted-text" style="margin:0 0 0.6rem;font-size:0.86rem">
        Total adds up Men + Women + Children as you type. Type over it to enter a different total.
      </p>
    </div>
    <div class="wide-cell attendance-counts-card" style="padding:0;border:0;box-shadow:none;background:transparent">
      <div class="counts-form">
        <label class="counts-field"><span>Men</span>
          <input type="number" name="attendanceMen" data-sum-to="attendanceTotal" min="0" step="1" value="${esc(e.attendanceMen ?? '')}"></label>
        <label class="counts-field"><span>Women</span>
          <input type="number" name="attendanceWomen" data-sum-to="attendanceTotal" min="0" step="1" value="${esc(e.attendanceWomen ?? '')}"></label>
        <label class="counts-field"><span>Children</span>
          <input type="number" name="attendanceChildren" data-sum-to="attendanceTotal" min="0" step="1" value="${esc(e.attendanceChildren ?? '')}"></label>
        <label class="counts-field counts-total"><span>Total</span>
          <input type="number" name="attendanceTotal" data-sum-total min="0" step="1" value="${esc(e.attendanceTotal ?? '')}" placeholder="auto">
        </label>
      </div>
    </div>
    <div class="wide-cell">
      <h3 class="form-section">By day-born</h3>
      <p class="muted-text" style="margin:0 0 0.6rem;font-size:0.86rem">
        How many came from each day-born group. Leave a box empty if you did not count it. These are a separate breakdown and do not change the Total above.
      </p>
      <div class="attendance-counts-card" style="padding:0;border:0;box-shadow:none;background:transparent"><div class="counts-form">${DAY_BORNS.map((d) => groupField(dayKey(d), `${dayLabel(d)}-born`, `day:${d}`)).join('')}</div></div>
    </div>
    ${orgs.length ? `<div class="wide-cell">
      <h3 class="form-section">By organization</h3>
      <p class="muted-text" style="margin:0 0 0.6rem;font-size:0.86rem">
        How many came from each organization. Leave a box empty if you did not count it.
      </p>
      <div class="attendance-counts-card" style="padding:0;border:0;box-shadow:none;background:transparent"><div class="counts-form">${orgs.map((o) => groupField(orgKey(o), o.name, `org:${o.id}`)).join('')}</div></div>
    </div>` : ''}
    <label class="wide">
      <span>Notes</span>
      <textarea name="notes" rows="2" placeholder="Optional notes about the service.">${esc(e.notes || '')}</textarea>
    </label>
    <div class="actions form-actions">
      <a class="btn ghost" href="/attendance">Cancel</a>
      <button type="submit">${isEdit ? 'Save changes' : 'Add service'}</button>
    </div>
    ${opts.extraButtons || ''}
  </form>`;
}

function register(app) {
  app.get('/attendance', asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    const db = res.locals.db;
    const isAdmin = res.locals.user.role === 'ADMIN';
    const canEdit = isAdmin || res.locals.user.role === 'EDITOR';

    const orgs = await loadOrgs(db);
    const services = await db.event.findMany({
      where: { eventType: 'SERVICE' },
      orderBy: { startsAt: 'desc' },
      take: 20,
      include: { _count: { select: { attendance: true } }, attendanceOrg: { select: { name: true } }, groupCounts: true },
    });
    const attendeesOf = (s) => s.attendanceTotal ?? s._count.attendance;
    const trend = services.slice(0, 8).reverse().map((r, i) => ({ label: `Wk ${i + 1}`, value: attendeesOf(r) }));
    const avg = trend.length ? Math.round(trend.reduce((a, b) => a + b.value, 0) / trend.length) : 0;
    const total = services.reduce((a, b) => a + attendeesOf(b), 0);
    const recorded = services.filter((s) => s.attendanceTotal !== null).length;
    const last = services[0];
    const previous = services[1];
    const lastTotal = last ? attendeesOf(last) : 0;
    const previousTotal = previous ? attendeesOf(previous) : 0;
    const change = previous ? lastTotal - previousTotal : 0;

    const hero = pageHero('Attendance',
      'Track service participation. Record Men / Women / Children counts per service — add or edit a service right here.');
    const stats = statsRow([
      { cls: 'gold', icon: icon('attendance'), value: avg.toLocaleString(), label: `Avg attendance (last ${trend.length})` },
      { cls: 'green', icon: icon('events'), value: services.length.toLocaleString(), label: 'Services tracked' },
      { cls: 'blue', icon: icon('ledger'), value: recorded.toLocaleString(), label: 'Counts recorded' },
      { cls: 'purple', icon: icon('members'), value: total.toLocaleString(), label: 'Total attendance' },
      { cls: change >= 0 ? 'green' : 'orange', icon: icon('delta'), value: previous ? `${change >= 0 ? '+' : ''}${change}` : '—', label: 'Last service change' },
    ], canEdit ? '<a class="btn primary" href="/attendance/new">＋ Add Service</a>' : '');

    const trendCard = `<div class="card">
      <div class="card-head"><h2>Attendance trend</h2><span class="meta">Last ${trend.length} services</span></div>
      ${sparkline(trend)}
    </div>`;

    // Totals per day-born and per organization over the services listed below.
    const orgName = new Map(orgs.map((o) => [o.id, o.name]));
    const dayTotals = new Map(), orgTotals = new Map();
    for (const sv of services) for (const g of sv.groupCounts) {
      const m = g.dayBorn ? dayTotals : orgTotals, k = g.dayBorn || g.orgId;
      m.set(k, (m.get(k) || 0) + g.count);
    }
    const groupRows = [
      ...DAY_BORNS.filter((d) => dayTotals.has(d)).map((d) => [`${dayLabel(d)}-born`, dayTotals.get(d)]),
      ...orgs.filter((o) => orgTotals.has(o.id)).map((o) => [o.name, orgTotals.get(o.id)]),
    ];
    const groupCard = groupRows.length
      ? `<div class="card">
      <div class="card-head"><h2>Attendance by group</h2><span class="meta">Across the ${services.length} services below</span></div>
      ${table(['Group', 'Attendance'], groupRows.map(([name, n]) => [esc(name), `<strong>${n.toLocaleString()}</strong>`]))}
    </div>`
      : '';
    const groupSummary = (sv) => {
      const parts = [
        ...DAY_BORNS.map((d) => [dayLabel(d).slice(0, 3), sv.groupCounts.find((g) => g.dayBorn === d)]),
        ...sv.groupCounts.filter((g) => g.orgId).map((g) => [orgName.get(g.orgId) || 'Organization', g]),
      ].filter(([, g]) => g).map(([name, g]) => `${esc(name)} ${g.count}`);
      const legacy = groupLabel(sv);
      if (legacy) parts.unshift(esc(legacy));
      return parts.length ? parts.join(' · ') : '<span class="muted-text">—</span>';
    };

    const cell = (v) => v == null ? '<span class="muted-text">—</span>' : `<strong>${esc(String(v))}</strong>`;
    const recent = services.length
      ? table(
          ['When', 'Title', 'Groups', 'Men', 'Women', 'Children', 'Total', 'Actions'],
          services.map((s) => [
            esc(isoLocal(s.startsAt).replace('T', ' ')),
            canEdit ? `<a href="/attendance/${s.id}/edit">${esc(s.title)}</a>` : esc(s.title),
            groupSummary(s),
            cell(s.attendanceMen), cell(s.attendanceWomen), cell(s.attendanceChildren), cell(s.attendanceTotal),
            canEdit ? `<a class="btn ghost" href="/attendance/${s.id}/edit">Edit →</a>` : '<span class="muted-text">—</span>',
          ]))
      : `<div class="empty-state">
          <div class="empty-ico" aria-hidden="true">✓</div>
          <h3>No services tracked yet</h3>
          <p>Add your first service to start recording attendance counts.</p>
          ${canEdit ? '<a class="btn primary" href="/attendance/new">＋ Add Service</a>' : ''}
        </div>`;
    const recentCard = listCard({ title: 'Recent services', count: services.length, countLabel: 'services', inner: recent });

    res.page({ title: 'Attendance', active: '/attendance', noHeader: true, body: `${hero}${stats}${trendCard}${groupCard}${recentCard}` });
  }));

  app.get('/attendance/new', requireEditor, asyncHandler(async (req, res) => {
    const orgs = await loadOrgs(res.locals.db);
    res.page({ title: 'New service', active: '/attendance', noHeader: true, body: `${pageHero('New service', '')}${serviceForm(null, '/attendance', { orgs, services: await serviceNames(res.locals.db) })}` });
  }));

  app.post('/attendance', requireEditor, asyncHandler(async (req, res) => {
    const v = parseServiceBody(req.body || {});
    if (!v.title || !v.startsAt || Number.isNaN(v.startsAt.getTime())) {
      flash(req, 'Service title and date are required.');
      return res.redirect('/attendance/new');
    }
    const groupRows = parseGroupCounts(req.body || {}, await loadOrgs(res.locals.db));
    const ev = await res.locals.db.event.create({ data: { ...v, eventType: 'SERVICE', checkinToken: crypto.randomBytes(16).toString('hex') } });
    await saveGroupCounts(res.locals.db, ev.id, groupRows);
    await logActivity(res.locals.db, 'attendance_recorded',
      `Service "${v.title}" added · M:${v.attendanceMen ?? '—'} W:${v.attendanceWomen ?? '—'} C:${v.attendanceChildren ?? '—'} Total:${v.attendanceTotal ?? '—'}`,
      `/attendance/${ev.id}/edit`, res.locals.user.id);
    flash(req, 'Service added.', 'success');
    res.redirect('/attendance');
  }));

  app.get('/attendance/:id/edit', requireEditor, asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const isAdmin = res.locals.user.role === 'ADMIN';
    const ev = await res.locals.db.event.findFirst({ where: { id, eventType: 'SERVICE' } });
    if (!ev) return res.status(404).send('Not found');
    const orgs = await loadOrgs(res.locals.db);
    const groupCounts = new Map((await res.locals.db.eventGroupAttendance.findMany({ where: { eventId: id } })).map((g) => [g.dayBorn ? `day:${g.dayBorn}` : `org:${g.orgId}`, g.count]));
    const extra = isAdmin ? `<div class="form-extra-actions" style="grid-column:1/-1;margin-top:0.6rem">
      <form method="post" action="/attendance/${id}/delete"
            data-confirm="Delete this service and its counts? This cannot be undone." style="display:inline">
        <button class="danger" type="submit">Delete service</button>
      </form>
    </div>` : '';
    res.page({
      title: `Edit service · ${ev.title}`, active: '/attendance', noHeader: true,
      body: `${pageHero(`Edit service · ${ev.title}`, '')}${serviceForm(ev, `/attendance/${id}`, { extraButtons: extra, orgs, groupCounts, services: await serviceNames(res.locals.db) })}`,
    });
  }));

  app.post('/attendance/:id', requireEditor, asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const v = parseServiceBody(req.body || {});
    if (!v.title || !v.startsAt || Number.isNaN(v.startsAt.getTime())) {
      flash(req, 'Service title and date are required.');
      return res.redirect(`/attendance/${id}/edit`);
    }
    const groupRows = parseGroupCounts(req.body || {}, await loadOrgs(res.locals.db));
    try {
      await res.locals.db.event.update({ where: { id }, data: v });
    } catch (e) {
      if (e.code !== 'P2025') throw e;
      return res.status(404).send('Not found');
    }
    await saveGroupCounts(res.locals.db, id, groupRows);
    await logActivity(res.locals.db, 'attendance_recorded',
      `Counts updated for "${v.title}" · M:${v.attendanceMen ?? '—'} W:${v.attendanceWomen ?? '—'} C:${v.attendanceChildren ?? '—'} Total:${v.attendanceTotal ?? '—'}`,
      `/attendance/${id}/edit`, res.locals.user.id);
    flash(req, 'Service updated.', 'success');
    res.redirect('/attendance');
  }));

  app.post('/attendance/:id/delete', requireAdmin, asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const ev = await res.locals.db.event.findFirst({ where: { id, eventType: 'SERVICE' } });
    if (!ev) return res.status(404).send('Not found');
    // Attendance rows cascade-delete with their Event (schema.prisma:
    // Attendance.event onDelete: Cascade) — matches routes-pg/attendance.js's note.
    await res.locals.db.event.delete({ where: { id } });
    await logActivity(res.locals.db, 'attendance_recorded', `Service "${ev.title}" deleted`, '/attendance', res.locals.user.id);
    flash(req, 'Service deleted.', 'success');
    res.redirect('/attendance');
  }));
}

module.exports = { register };
