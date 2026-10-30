'use strict';
// Phase 8d: HTML port of routes/members.js onto the Postgres stack.
// Registered ALONGSIDE routes-pg/members.js (JSON at /api/members, this is
// the bare-path HTML surface).
//
// SCOPE matches routes-pg/members.js exactly: core member CRUD + directly-
// owned relations (organization memberships, active ministry memberships,
// sacraments, recent attendance). DEFERRED, same as the JSON layer:
// CSV export/import, bulk actions, absent-members report, and the detail
// page's giving/pledges/activity timeline (needs Finance models + a
// not-yet-built audit-log write path — Phase 8e).
//
// Phase 9c added photo upload — local Fly volume (PHOTO_DIR), ported
// near-verbatim from the original (memoryStorage multer -> fs.writeFileSync
// keyed by Member.id + extension). Member.id is a single global Postgres
// sequence (not per-church), so `${id}.${ext}` filenames stay
// collision-free across tenants exactly as they were single-tenant.
// GET /photos/:filename (below) has a real cross-tenant concern the
// original never had (single-tenant = no other church's photos existed to
// leak): it verifies the requesting user's OWN church actually owns a
// member with that photoFilename via the tenant-scoped `db` before serving
// the file, so a curious/malicious user from church B can't view church
// A's member photos by guessing `{id}.{ext}` filenames from a shared
// directory.

const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { scriptTag } = require('../lib/style-tags');
const asyncHandler = require('../lib/async-handler');
const { pickEnum, cleanDate, memberFieldError, createMemberWithId, GENDERS, MARITAL_STATUSES: MARITAL_ENUM, PREFERRED_CHANNELS } = require('../lib/member-input');
const { esc, initials, fmtDate, DAYS_OF_WEEK, MONTHS, looksLikeImage, imageExt, dobMonth, dobDay, dobYear, dobHasYear, birthDate, fmtBirthday } = require('../lib/format');
const { pageHero, pager, ICON_EYE, ICON_PENCIL, ICON_TRASH, memberAvatar } = require('../lib/views');
const { flash } = require('../lib/tenant-flash');
const { logActivity } = require('../lib/tenant-activity');
const { icon } = require('../lib/icons');
const { csrfValid } = require('../lib/tenant-csrf');
const { renderMemberProfile } = require('../lib/member-profile');
const { sendCsv } = require('../lib/csv');

const PHOTO_DIR = process.env.PHOTO_DIR || path.join(__dirname, '..', 'photos');
try { fs.mkdirSync(PHOTO_DIR, { recursive: true }); } catch (_) { /* already exists */ }
const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024 }, // 4 MB
  fileFilter: (req, file, cb) => {
    const ok = /^image\/(jpe?g|png|webp|gif)$/i.test(file.mimetype);
    cb(ok ? null : new Error('Only JPG / PNG / WebP / GIF images are allowed'), ok);
  },
});
const EXT_FROM_MIME = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

function requireAdmin(req, res, next) {
  if (res.locals.user && res.locals.user.role === 'ADMIN') return next();
  return res.status(403).send('Forbidden');
}
// Editors can add and edit members; archiving, export and messaging stay
// with admins.
function requireEditor(req, res, next) {
  if (res.locals.user && ['ADMIN', 'EDITOR'].includes(res.locals.user.role)) return next();
  return res.status(403).send('Forbidden');
}

const MEMBERSHIP_STATUSES = ['VISITOR', 'REGULAR', 'MEMBER', 'DISTANT', 'INACTIVE', 'TRANSFERRED', 'DECEASED', 'OTHER'];
const MEMBER_STATUS_LABELS = { VISITOR: 'Visitor', REGULAR: 'Regular', MEMBER: 'Member', DISTANT: 'Distant', INACTIVE: 'Inactive', TRANSFERRED: 'Transferred', DECEASED: 'Deceased', OTHER: 'Other' };
// What the member form offers. Regular, Inactive and Other are no longer
// offered, but a member who already has one keeps it (it is shown as their
// current choice) until someone picks another.
const FORM_STATUSES = ['MEMBER', 'VISITOR', 'DISTANT', 'TRANSFERRED', 'DECEASED'];
const EMERGENCY_RELATIONS = ['Spouse', 'Parent', 'Child', 'Sibling', 'Other relative', 'Guardian', 'Friend', 'Other'];
const PREF_LABELS = { EITHER: 'Both', SMS_ONLY: 'SMS only', EMAIL_ONLY: 'Email only', NONE: 'Do not contact' };
const MARITAL_STATUSES = ['', 'SINGLE', 'MARRIED', 'DIVORCED', 'WIDOWED', 'SEPARATED', 'OTHER'];
const AKAN_NAMES = { Sunday: 'Akosua / Kwasi', Monday: 'Adwoa / Kwadwo', Tuesday: 'Abena / Kwabena', Wednesday: 'Akua / Kwaku', Thursday: 'Yaa / Yaw', Friday: 'Afia / Kofi', Saturday: 'Ama / Kwame' };
const MEMBERS_PER_PAGE = 25;

function isEmailish(s) { return !s || /^\S+@\S+\.\S+$/.test(s); }
function isPhoneish(s) { return !s || /\d{7,}/.test(String(s).replace(/\D/g, '')); }
function memberErrors(b) {
  if (!b.firstName || !String(b.firstName).trim()) return 'First name is required.';
  if (!b.lastName || !String(b.lastName).trim()) return 'Last name is required.';
  if (b.email && !isEmailish(b.email)) return 'Enter a valid email address, or leave it blank.';
  if (b.mobilePhone && !isPhoneish(b.mobilePhone)) return 'Enter a valid mobile number (at least 7 digits).';
  if ((b.dobDay || b.dobMonth) && !birthDate(b.dobMonth, b.dobDay)) {
    return b.dobDay && b.dobMonth ? 'That date of birth does not exist. Check the day and month.' : 'Pick both the day and the month of birth, or neither.';
  }
  return memberFieldError(b);
}

function parseMemberBody(b) {
  return {
    bibleClassId: b.bibleClassId ? Number(b.bibleClassId) : null,
    firstName: (b.firstName || '').trim(),
    lastName: (b.lastName || '').trim(),
    email: (b.email || '').trim() || null,
    mobilePhone: (b.mobilePhone || '').trim() || null,
    dateOfBirth: 'dobDay' in b || 'dobMonth' in b ? cleanDate(birthDate(b.dobMonth, b.dobDay, b.dobYear)) : cleanDate(b.dateOfBirth),
    dayBorn: DAYS_OF_WEEK.includes(b.dayBorn) ? b.dayBorn : null,
    gender: pickEnum(b.gender, GENDERS),
    maritalStatus: pickEnum(b.maritalStatus, MARITAL_ENUM),
    membershipStatus: MEMBERSHIP_STATUSES.includes(b.membershipStatus) ? b.membershipStatus : 'VISITOR',
    joinDate: cleanDate(b.joinDate),
    baptismDate: cleanDate(b.baptismDate),
    confirmationDate: cleanDate(b.confirmationDate),
    notes: (b.notes || '').trim() || null,
    emergencyContactName: (b.emergencyContactName || '').trim() || null,
    emergencyContactPhone: (b.emergencyContactPhone || '').trim() || null,
    emergencyContactRelation: (b.emergencyContactRelation || '').trim() || null,
    preferredChannel: pickEnum(b.preferredChannel, PREFERRED_CHANNELS, 'NONE'),
  };
}

function parseOrgIds(body) {
  const v = body.orgIds;
  if (!v) return [];
  return (Array.isArray(v) ? v : [v]).map((x) => Number(x)).filter(Boolean);
}

async function saveMemberOrgs(db, memberId, orgIds) {
  await db.organizationMembership.deleteMany({ where: { memberId } });
  if (orgIds.length) await db.organizationMembership.createMany({ data: orgIds.map((orgId) => ({ orgId, memberId })) });
}

// createMany only stamps churchId onto each new row — it does not verify
// that a client-supplied orgId belongs to this tenant, so callers must
// validate orgIds through the scoped client before calling saveMemberOrgs,
// or a cross-tenant orgId in the request body would silently link the
// member into another church's organization roster.
async function validOrgIds(db, orgIds) {
  if (!orgIds.length) return true;
  const found = await db.organization.count({ where: { id: { in: orgIds } } });
  return found === new Set(orgIds).size;
}

// Same tenant-validation as validOrgIds, for Member.bibleClassId.
async function checkBibleClassId(db, bodyBibleClassId) {
  if (!bodyBibleClassId) return { ok: true, bibleClassId: null };
  const ministry = await db.ministry.findUnique({ where: { id: Number(bodyBibleClassId) } });
  return ministry ? { ok: true, bibleClassId: ministry.id } : { ok: false, bibleClassId: null };
}

async function memberForm(db, member = {}, memberOrgIds, action) {
  const [bibleClasses, organizations] = await Promise.all([
    db.ministry.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } }),
    db.organization.findMany({ where: { active: true }, orderBy: { name: 'asc' }, select: { id: true, name: true } }),
  ]);
  const bibleClassOpts = '<option value="">— none —</option>' +
    bibleClasses.map((b) => `<option value="${b.id}" ${b.id === member.bibleClassId ? 'selected' : ''}>${esc(b.name)}</option>`).join('');
  const currentStatus = member.membershipStatus || 'VISITOR';
  const statusOpts = [...FORM_STATUSES, ...(FORM_STATUSES.includes(currentStatus) ? [] : [currentStatus])]
    .map((s) => `<option value="${s}" ${s === currentStatus ? 'selected' : ''}>${MEMBER_STATUS_LABELS[s]}</option>`).join('');
  // Birthday: day and month only. A year already on file (from an import or
  // the API) is kept as long as the date is still valid.
  const dobM = dobMonth(member.dateOfBirth), dobD = dobDay(member.dateOfBirth);
  const dayOpts = '<option value="">Day</option>' + Array.from({ length: 31 }, (_, i) => i + 1).map((d) => `<option value="${d}" ${d === dobD ? 'selected' : ''}>${d}</option>`).join('');
  const monthOpts = '<option value="">Month</option>' + MONTHS.map((name, i) => `<option value="${i + 1}" ${i + 1 === dobM ? 'selected' : ''}>${name}</option>`).join('');
  // Emergency contact relationship: picked from a list. A value typed before
  // the list existed ("uncle") is kept as the current choice until changed.
  const relation = member.emergencyContactRelation || '';
  const listed = EMERGENCY_RELATIONS.find((r) => r.toLowerCase() === relation.trim().toLowerCase());
  const relationOpts = '<option value="">—</option>'
    + (relation && !listed ? `<option value="${esc(relation)}" selected>${esc(relation)}</option>` : '')
    + EMERGENCY_RELATIONS.map((r) => `<option value="${r}" ${r === listed ? 'selected' : ''}>${r}</option>`).join('');
  const keptYear = member.dateOfBirth && dobHasYear(member.dateOfBirth) ? `<input type="hidden" name="dobYear" value="${dobYear(member.dateOfBirth)}">` : '';
  const maritalOpts = MARITAL_STATUSES.map((s) => `<option value="${s}" ${s === (member.maritalStatus || '') ? 'selected' : ''}>${s || '—'}</option>`).join('');
  const genderLabels = { '': '—', M: 'M', F: 'F', O: 'Other' };
  const genderOpts = ['', 'M', 'F', 'O'].map((s) => `<option value="${s}" ${s === (member.gender || '') ? 'selected' : ''}>${genderLabels[s]}</option>`).join('');
  const orgChecks = organizations.map((o) => `
      <label class="check"><input type="checkbox" name="orgIds" value="${o.id}"
        ${(memberOrgIds || []).includes(o.id) ? 'checked' : ''}> ${esc(o.name)}</label>`).join('');
  const orgsOpen = (memberOrgIds || []).length > 0;
  const memberIdField = member.id
    ? `<label>Member ID<input value="${esc(member.externalId || '')}" readonly></label>`
    : `<label>Member ID<input value="(auto-generated on save)" readonly></label>`;
  return `
    <form method="post" action="${action}" class="form">
      ${memberIdField}
      <label>Status<select name="membershipStatus" required>${statusOpts}</select></label>
      <label>First name<input name="firstName" required value="${esc(member.firstName)}"></label>
      <label>Last name<input name="lastName" required value="${esc(member.lastName)}"></label>
      <label>Email<input type="email" name="email" value="${esc(member.email)}"></label>
      <label>Mobile<input name="mobilePhone" required value="${esc(member.mobilePhone)}"></label>
      <fieldset class="dob-field"><legend>Date of birth</legend>
        <select name="dobDay" aria-label="Day of birth">${dayOpts}</select>
        <select name="dobMonth" aria-label="Month of birth">${monthOpts}</select>
        ${keptYear}
      </fieldset>
      <label>Day born<select name="dayBorn">
        <option value="">—</option>
        ${DAYS_OF_WEEK.map((d) => `<option value="${d}" ${d === (member.dayBorn || '') ? 'selected' : ''}>${d}</option>`).join('')}
      </select></label>
      <label>Gender<select name="gender" required>${genderOpts}</select></label>
      <label>Marital<select name="maritalStatus">${maritalOpts}</select></label>
      <label>Bible class<select name="bibleClassId">${bibleClassOpts}</select></label>
      <label>Communication preference
        <select name="preferredChannel" required>
          ${Object.entries(PREF_LABELS).map(([v, l]) => `<option value="${v}" ${v === (member.preferredChannel || 'NONE') ? 'selected' : ''}>${esc(l)}</option>`).join('')}
        </select>
        <span class="hint">New members default to <em>Do not contact</em>. Switch once the member consents to SMS / email.</span>
      </label>
      <label>Join date<input type="date" name="joinDate" value="${fmtDate(member.joinDate instanceof Date ? member.joinDate.toISOString() : member.joinDate)}"></label>
      <label>Baptism date<input type="date" name="baptismDate" value="${fmtDate(member.baptismDate instanceof Date ? member.baptismDate.toISOString() : member.baptismDate)}"></label>
      <label>Confirmation date<input type="date" name="confirmationDate" value="${fmtDate(member.confirmationDate instanceof Date ? member.confirmationDate.toISOString() : member.confirmationDate)}"></label>
      <div class="wide-cell">
        <details class="form-toggle" ${orgsOpen ? 'open' : ''}>
          <summary><strong>Choose organizations</strong>
            <span class="muted-text">${orgsOpen ? `(${memberOrgIds.length} selected)` : '(optional — click to expand)'}</span>
          </summary>
          <div class="check-grid" style="margin-top:0.5rem">${orgChecks || '<span class="muted-text">No organizations yet.</span>'}</div>
        </details>
      </div>
      <div class="wide-cell"><h3 class="form-section">Emergency contact</h3></div>
      <label>Contact name<input name="emergencyContactName" value="${esc(member.emergencyContactName)}"></label>
      <label>Contact phone<input name="emergencyContactPhone" value="${esc(member.emergencyContactPhone)}"></label>
      <label>Relationship<select name="emergencyContactRelation">${relationOpts}</select></label>
      <label class="wide">Notes<textarea name="notes" rows="3">${esc(member.notes)}</textarea></label>
      <div class="actions form-actions">
        <a class="btn ghost" href="/members">Cancel</a>
        <button type="submit">Save member</button>
      </div>
    </form>`;
}

// Directory filters, shared by the list and the CSV export so an export is
// exactly what the list shows. Every filter takes several values (ORed).
function memberFilters(query) {
  const list = (v) => [].concat(v || []).map((x) => String(x).trim()).filter(Boolean);
  const ids = (v) => list(v).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  return {
    q: String(query.q || '').trim(),
    statuses: list(query.status).filter((st) => MEMBERSHIP_STATUSES.includes(st)),
    orgIds: ids(query.org),
    classIds: ids(query.class),
    daysBorn: list(query.day_born).filter((d) => DAYS_OF_WEEK.includes(d)),
  };
}
function memberWhere({ q, statuses, orgIds, classIds, daysBorn }) {
  return {
    deletedAt: null,
    ...(statuses.length ? { membershipStatus: { in: statuses } } : {}),
    ...(classIds.length ? { bibleClassId: { in: classIds } } : {}),
    ...(daysBorn.length ? { dayBorn: { in: daysBorn } } : {}),
    ...(orgIds.length ? { orgMemberships: { some: { orgId: { in: orgIds } } } } : {}),
    ...(q ? { OR: [
      { firstName: { contains: q, mode: 'insensitive' } }, { lastName: { contains: q, mode: 'insensitive' } },
      { email: { contains: q, mode: 'insensitive' } }, { mobilePhone: { contains: q } }, { externalId: { contains: q, mode: 'insensitive' } },
    ] } : {}),
  };
}
// "1,2,3" or repeated ?ids= values, capped so a URL can't ask for the world.
const MAX_SELECTED = 500;
function selectedIds(raw) {
  const out = [...new Set([].concat(raw || []).flatMap((v) => String(v).split(',')).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  return out.slice(0, MAX_SELECTED);
}

function register(app) {
  // Members directory, Precision layout: status tabs over a filter panel
  // (status and organisation multi-select; Bible class and day born one at a
  // time, by the panel script) and a
  // dense table. Everything is a plain GET form, so filters are shareable
  // links and work without JavaScript; the shell's live search swaps the
  // results in place when it is available.
  app.get('/members', asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    const db = res.locals.db;
    const user = res.locals.user;
    const isAdmin = user.role === 'ADMIN';
    const canEdit = isAdmin || user.role === 'EDITOR';
    const canMoney = isAdmin || (user.financeRole && user.financeRole !== 'NONE');
    const filters = memberFilters(req.query);
    const { q, statuses, orgIds, classIds, daysBorn } = filters;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const where = memberWhere(filters);

    const [matched, rows, byStatus, classes, orgs, orgCounts, classCounts, dayCounts] = await Promise.all([
      db.member.count({ where }),
      db.member.findMany({
        where, orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }], take: MEMBERS_PER_PAGE, skip: (page - 1) * MEMBERS_PER_PAGE,
        include: { bibleClass: { select: { name: true } }, orgMemberships: { select: { organization: { select: { name: true } } } } },
      }),
      db.member.groupBy({ by: ['membershipStatus'], where: { deletedAt: null }, _count: true }),
      db.ministry.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } }),
      db.organization.findMany({ where: { active: true }, orderBy: { name: 'asc' }, select: { id: true, name: true } }),
      db.organizationMembership.groupBy({ by: ['orgId'], where: { member: { deletedAt: null } }, _count: true }),
      db.member.groupBy({ by: ['bibleClassId'], where: { deletedAt: null }, _count: true }),
      db.member.groupBy({ by: ['dayBorn'], where: { deletedAt: null }, _count: true }),
    ]);
    const pages = Math.max(1, Math.ceil(matched / MEMBERS_PER_PAGE));

    // Attendance over the last 12 weeks and giving this year, for this page's rows only.
    const ids = rows.map((r) => r.id);
    const weekMs = 7 * 86400000;
    const since = new Date(Date.now() - 12 * weekMs);
    const yearStart = new Date(new Date().getFullYear(), 0, 1);
    const [checkins, tithes, income] = ids.length ? await Promise.all([
      db.attendance.findMany({ where: { memberId: { in: ids }, checkedInAt: { gte: since } }, select: { memberId: true, checkedInAt: true } }),
      canMoney ? db.tithe.groupBy({ by: ['memberId'], where: { memberId: { in: ids }, deletedAt: null, titheDate: { gte: yearStart } }, _sum: { amount: true } }) : [],
      canMoney ? db.incomeRecord.groupBy({ by: ['memberId'], where: { memberId: { in: ids }, deletedAt: null, transactionDate: { gte: yearStart } }, _sum: { amount: true } }) : [],
    ]) : [[], [], []];
    const weeksSeen = new Map();
    for (const c of checkins) {
      const w = Math.min(11, Math.floor((c.checkedInAt - since) / weekMs));
      if (!weeksSeen.has(c.memberId)) weeksSeen.set(c.memberId, new Set());
      weeksSeen.get(c.memberId).add(w);
    }
    const giving = new Map();
    for (const g of [...tithes, ...income]) giving.set(g.memberId, (giving.get(g.memberId) || 0) + Number(g._sum.amount || 0));

    // ---- tabs and filter panel ----
    const count = Object.fromEntries(byStatus.map((s) => [s.membershipStatus, s._count]));
    const total = byStatus.reduce((n, s) => n + s._count, 0);
    const active = (count.MEMBER || 0) + (count.REGULAR || 0) + (count.VISITOR || 0);
    const qs = (over) => {
      const p = new URLSearchParams();
      const st = over.statuses || statuses;
      if (q) p.append('q', q);
      st.forEach((s) => p.append('status', s));
      if (!over.statuses) { orgIds.forEach((o) => p.append('org', o)); classIds.forEach((c) => p.append('class', c)); daysBorn.forEach((d) => p.append('day_born', d)); }
      const s = p.toString();
      return `/members${s ? `?${s}` : ''}`;
    };
    // Regulars and Inactive are no longer given out; their tabs stay while anyone has them.
    const TABS = [['', 'All people', total], ['MEMBER', 'Members', count.MEMBER], ['VISITOR', 'Visitors', count.VISITOR], ['DISTANT', 'Distant', count.DISTANT],
      ...(count.REGULAR ? [['REGULAR', 'Regulars', count.REGULAR]] : []), ...(count.INACTIVE ? [['INACTIVE', 'Inactive', count.INACTIVE]] : [])];
    const tabOn = (key) => (key ? statuses.length === 1 && statuses[0] === key : statuses.length === 0);
    const tabs = `<nav class="pm-tabs" id="pmTabs" data-live-sync aria-label="Status">${TABS.map(([key, label, n]) => `<a href="${qs({ statuses: key ? [key] : [] })}"${tabOn(key) ? ' aria-current="page"' : ''}>${label}<span>${(n || 0).toLocaleString()}</span></a>`).join('')}</nav>`;

    const checks = (name, items, picked) => items.map(([value, label, n, title]) => `<label class="pm-opt"${title ? ` title="${esc(title)}"` : ''}><input type="checkbox" name="${name}" value="${esc(value)}"${picked.includes(value) ? ' checked' : ''}><span>${esc(label)}</span>${n == null ? '' : `<small>${Number(n).toLocaleString()}</small>`}</label>`).join('');
    const orgN = Object.fromEntries(orgCounts.map((o) => [o.orgId, o._count]));
    const classN = Object.fromEntries(classCounts.map((c) => [c.bibleClassId, c._count]));
    const dayN = Object.fromEntries(dayCounts.map((d) => [d.dayBorn, d._count]));
    const nFilters = statuses.length + orgIds.length + classIds.length + daysBorn.length;
    const filtered = Boolean(q || nFilters);
    const panel = `<aside class="card pm-facets" id="pmFacets" aria-label="Filters">
        <div class="pm-fh" id="pmFh" data-live-sync><b>Filters</b>${filtered ? '<a href="/members">Clear all</a>' : '<span class="muted-text">None applied</span>'}</div>
        <div class="pm-fg"><h3>Status</h3>${checks('status', ['MEMBER', 'VISITOR', 'DISTANT', 'TRANSFERRED', 'DECEASED', 'REGULAR', 'INACTIVE', 'OTHER'].filter((s) => count[s] || statuses.includes(s)).map((s) => [s, MEMBER_STATUS_LABELS[s], count[s] || 0]), statuses)}</div>
        ${orgs.length ? `<div class="pm-fg"><h3>Organisations</h3>${checks('org', orgs.map((o) => [String(o.id), o.name, orgN[o.id] || 0]), orgIds.map(String))}</div>` : ''}
        ${classes.length ? `<div class="pm-fg" data-pick-one><h3>Bible class</h3>${checks('class', classes.map((c) => [String(c.id), c.name, classN[c.id] || 0]), classIds.map(String))}</div>` : ''}
        <div class="pm-fg" data-pick-one><h3>Day born</h3>${checks('day_born', DAYS_OF_WEEK.map((d) => [d, d, dayN[d] || 0, `${d}-born · ${AKAN_NAMES[d]}`]), daysBorn)}</div>
        <div class="pm-sheet-foot"><button type="submit">Show results</button></div>
        <noscript><div class="pm-fg"><button type="submit">Apply filters</button></div></noscript>
      </aside>`;

    // ---- table ----
    const weeksCell = (id) => {
      const seen = weeksSeen.get(id) || new Set();
      return `<span class="pm-att" title="Present ${seen.size} of the last 12 weeks">${Array.from({ length: 12 }, (_, i) => `<i${seen.has(i) ? ' class="on"' : ''}></i>`).join('')}</span><span class="muted-text pm-attpct">${Math.round(seen.size / 12 * 100)}%</span>`;
    };
    const rowHtml = rows.map((r) => {
      const avatar = memberAvatar({ photo_filename: r.photoFilename, first_name: r.firstName, last_name: r.lastName });
      const orgNames = r.orgMemberships.map((o) => o.organization.name);
      const sub = [r.externalId, r.mobilePhone].filter(Boolean).map(esc).join(' · ') || 'No phone';
      const actions = `<div class="row-actions">
          <a class="icon-btn view" href="/members/${r.id}" title="View" aria-label="View ${esc(r.firstName)}">${ICON_EYE}</a>
          ${canEdit ? `<a class="icon-btn edit" href="/members/${r.id}#edit" title="Edit" aria-label="Edit">${ICON_PENCIL}</a>` : ''}
          ${isAdmin ? `<form method="post" action="/members/${r.id}/delete" data-confirm="Archive this member? They will be hidden but not permanently deleted.">
            <button class="icon-btn del" type="submit" title="Archive" aria-label="Archive">${ICON_TRASH}</button>
          </form>` : ''}
        </div>`;
      return `<tr>
        ${isAdmin ? `<td class="pm-sel"><input type="checkbox" class="pm-box" value="${r.id}" aria-label="Select ${esc(r.firstName)} ${esc(r.lastName)}"></td>` : ''}
        <td data-label="Name"><div class="m-name-cell">${avatar}<div><a class="m-name" href="/members/${r.id}">${esc(r.firstName)} ${esc(r.lastName)}</a><div class="m-sub">${sub}</div></div></div></td>
        <td data-label="Status"><span class="pill pill-${esc(r.membershipStatus.toLowerCase())}">${esc(MEMBER_STATUS_LABELS[r.membershipStatus] || r.membershipStatus)}</span></td>
        <td data-label="Class">${esc(r.bibleClass && r.bibleClass.name) || '<span class="muted-text">—</span>'}</td>
        <td data-label="Organisations">${orgNames.length ? `<span class="pm-chip">${esc(orgNames[0])}</span>${orgNames.length > 1 ? ` <span class="pm-chip" title="${esc(orgNames.slice(1).join(', '))}">+${orgNames.length - 1}</span>` : ''}` : '<span class="muted-text">—</span>'}</td>
        <td data-label="Attendance" class="pm-nowrap">${weeksCell(r.id)}</td>
        ${canMoney ? `<td data-label="Giving YTD" class="pm-num">${giving.get(r.id) ? esc(`GH₵ ${Math.round(giving.get(r.id)).toLocaleString('en-GH')}`) : '<span class="muted-text">—</span>'}</td>` : ''}
        <td data-label="Actions">${actions}</td>
      </tr>`;
    }).join('');
    const from = matched ? (page - 1) * MEMBERS_PER_PAGE + 1 : 0;
    const to = Math.min(matched, page * MEMBERS_PER_PAGE);
    const pagerQuery = [];
    if (q) pagerQuery.push(['q', q]);
    statuses.forEach((s) => pagerQuery.push(['status', s]));
    orgIds.forEach((o) => pagerQuery.push(['org', String(o)]));
    classIds.forEach((c) => pagerQuery.push(['class', String(c)]));
    daysBorn.forEach((d) => pagerQuery.push(['day_born', d]));
    const exportQs = pagerQuery.length ? `?${new URLSearchParams(pagerQuery).toString()}` : '';
    const results = `<section class="card pm-results" data-results>
        ${rows.length ? `<div class="table-wrap"><table class="data-table members-table">
          <thead><tr>${isAdmin ? '<th class="pm-sel"><input type="checkbox" class="pm-all" aria-label="Select everyone on this page"></th>' : ''}<th>Name</th><th>Status</th><th>Class</th><th>Organisations</th><th title="Weeks present out of the last 12">Attendance</th>${canMoney ? '<th class="pm-num">Giving YTD</th>' : ''}<th><span class="sr-only">Actions</span></th></tr></thead>
          <tbody>${rowHtml}</tbody></table></div>
          <div class="pm-foot"><span>Showing ${from.toLocaleString()}–${to.toLocaleString()} of ${matched.toLocaleString()}${filtered ? ' matching' : ''}</span>${pager('/members', pagerQuery, page, pages)}</div>`
        : `<div class="empty-state">
          <h3>${filtered ? 'No one matches these filters' : 'No members yet'}</h3>
          <p>${filtered ? 'Try removing a filter, or search by phone number.' : 'Add your first member and the directory will start filling up.'}</p>
          ${filtered ? '<a class="btn ghost" href="/members">Clear all filters</a>' : (canEdit ? '<a class="btn" href="/members/new">Add member</a>' : '')}
        </div>`}
      </section>`;

    const head = `<header class="pm-head">
        <div><h1>Members</h1><p class="subtitle">${active.toLocaleString()} active people${classes.length ? ` across ${classes.length} Bible class${classes.length === 1 ? '' : 'es'}` : ''}${orgs.length ? ` and ${orgs.length} organisation${orgs.length === 1 ? '' : 's'}` : ''}.</p></div>
        <div class="pm-actions"><a class="btn ghost" href="/bible-classes">${icon('book')} Bible classes</a>${canEdit ? `<a class="btn" href="/members/new">${icon('plus')} Add member</a>` : ''}</div>
      </header>`;
    const body = `${head}${tabs}
      <form class="pm-layout" method="get" action="/members" data-live-search role="search">
        ${panel}
        <div class="pm-main">
          <div class="pm-toolbar">
            <div class="search-field"><span aria-hidden="true">${icon('search')}</span><input type="search" name="q" value="${esc(q)}" placeholder="Search name, ID, phone or email…" aria-label="Search members"></div>
            ${isAdmin ? `<a class="btn ghost pm-import" href="/members/import" title="Add members from a CSV or Excel file">${icon('plus')} Import</a>` : ''}
            ${isAdmin ? `<span id="pmExport" data-live-sync><a class="btn ghost pm-export" href="/members/export.csv${exportQs}" title="Download everyone matching these filters as CSV">${icon('download')} Export</a></span>` : ''}
            <button class="btn ghost pm-fbtn" type="button" aria-controls="pmFacets" aria-expanded="false">${icon('menu')} Filters<span id="pmBadge" data-live-sync>${nFilters ? ` <span class="pm-badge">${nFilters}</span>` : ''}</span></button>
          </div>
          ${results}
        </div>
      </form>
      ${isAdmin ? `<div class="pm-bulk" id="pmBulk" role="region" aria-label="Selected members" hidden>
        <b><span id="pmBulkN">0</span> selected</b>
        <a class="pm-bulk-btn" id="pmBulkSms" href="/communications/broadcast">${icon('message')} Send SMS</a>
        <a class="pm-bulk-btn" id="pmBulkCsv" href="/members/export.csv">${icon('download')} Export</a>
        <span class="pm-bulk-sep"></span>
        <button class="pm-bulk-btn" id="pmBulkClear" type="button" aria-label="Clear selection">${icon('x')}</button>
      </div>
      ${scriptTag('members-select', `data-max="${MAX_SELECTED}"`)}` : ''}
      <div class="pp-scrim" id="ppScrim" hidden></div>
      <aside class="pp-drawer" id="ppDrawer" role="dialog" aria-modal="true" aria-labelledby="ppTitle" aria-hidden="true">
        <div class="pp-top"><span>Member</span><span class="pp-grow"></span>
          <a class="pc-ib" id="ppFull" href="/members" title="Open full profile" aria-label="Open full profile">${icon('external')}</a>
          <button class="pc-ib" id="ppClose" type="button" aria-label="Close">${icon('x')}</button></div>
        <div class="pp-body" id="ppBody" aria-live="polite"></div>
      </aside>
      ${scriptTag('members-panel')}`;

    res.page({ title: 'Members', active: '/members', noHeader: true, body });
  }));

  app.get('/members/new', requireEditor, asyncHandler(async (req, res) => {
    res.page({ title: 'New member', active: '/members', noHeader: true, body: `${pageHero('New member', '')}${await memberForm(res.locals.db, {}, [], '/members')}` });
  }));

  app.post('/members', requireEditor, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const b = req.body || {};
    const err = memberErrors(b);
    if (err) { flash(req, err); return res.redirect('/members/new'); }
    const orgIds = parseOrgIds(b);
    if (!(await validOrgIds(db, orgIds))) { flash(req, 'One or more organizations were not found.'); return res.redirect('/members/new'); }
    const bibleClassCheck = await checkBibleClassId(db, b.bibleClassId);
    if (!bibleClassCheck.ok) { flash(req, 'Bible class not found.'); return res.redirect('/members/new'); }
    const member = await createMemberWithId(db, { ...parseMemberBody(b), bibleClassId: bibleClassCheck.bibleClassId });
    const externalId = member.externalId;
    if (orgIds.length) await saveMemberOrgs(db, member.id, orgIds);
    await logActivity(db, 'member_added', `New member added: ${b.firstName} ${b.lastName} (${externalId})`, `/members/${member.id}`, res.locals.user.id);
    res.redirect(`/members/${member.id}`);
  }));

  // CSV of the directory: the selected members (?ids=) or everyone matching
  // the current filters. Admins only, since it carries contact details, and
  // logged to the activity feed. Registered before /members/:id.
  app.get('/members/export.csv', requireAdmin, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const ids = selectedIds(req.query.ids);
    const where = ids.length ? { deletedAt: null, id: { in: ids } } : memberWhere(memberFilters(req.query));
    const rows = await db.member.findMany({
      where, orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }], take: 20000,
      include: { bibleClass: { select: { name: true } }, orgMemberships: { select: { organization: { select: { name: true } } } } },
    });
    // A birthday without a year exports as "14 March", which imports back as it is.
    const day = (d) => (!d ? '' : dobHasYear(d) ? new Date(d).toISOString().slice(0, 10) : fmtBirthday(d));
    await logActivity(db, 'members_exported', `Exported ${rows.length} member${rows.length === 1 ? '' : 's'} to CSV`, '/members', res.locals.user.id);
    sendCsv(res, `members-${new Date().toISOString().slice(0, 10)}.csv`,
      ['Member ID', 'First name', 'Last name', 'Status', 'Mobile', 'Email', 'Gender', 'Date of birth', 'Day born', 'Bible class', 'Organisations', 'Joined', 'Preferred channel'],
      rows.map((m) => [m.externalId, m.firstName, m.lastName, MEMBER_STATUS_LABELS[m.membershipStatus] || m.membershipStatus, m.mobilePhone, m.email,
        { M: 'Male', F: 'Female', O: 'Other' }[m.gender] || '', day(m.dateOfBirth), m.dayBorn, m.bibleClass && m.bibleClass.name,
        m.orgMemberships.map((o) => o.organization.name).join('; '), day(m.joinDate), m.preferredChannel]));
  }));

  // Profile summary for the slide-in panel on the directory. Returns an HTML
  // fragment (no page shell); the full profile stays at /members/:id. Scoped
  // through res.locals.db like every member read, so another church's id is
  // simply not found.
  app.get('/members/:id/panel', asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.status(401).send('Sign in again to see this member.');
    const db = res.locals.db;
    const user = res.locals.user;
    const isAdmin = user.role === 'ADMIN';
    const canEdit = isAdmin || user.role === 'EDITOR';
    const canMoney = isAdmin || (user.financeRole && user.financeRole !== 'NONE');
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(404).send('Member not found.');
    const m = await db.member.findFirst({
      where: { id, deletedAt: null },
      include: { bibleClass: { select: { name: true } }, orgMemberships: { select: { organization: { select: { name: true } } } } },
    });
    if (!m) return res.status(404).send('Member not found.');

    const weekMs = 7 * 86400000;
    const since = new Date(Date.now() - 12 * weekMs);
    const yearStart = new Date(new Date().getFullYear(), 0, 1);
    const [recent, checkins, tithes, income] = await Promise.all([
      db.attendance.findMany({ where: { memberId: id }, include: { event: { select: { id: true, title: true, startsAt: true } } }, orderBy: { checkedInAt: 'desc' }, take: 5 }),
      db.attendance.findMany({ where: { memberId: id, checkedInAt: { gte: since } }, select: { checkedInAt: true } }),
      canMoney ? db.tithe.aggregate({ where: { memberId: id, deletedAt: null, titheDate: { gte: yearStart } }, _sum: { amount: true } }) : null,
      canMoney ? db.incomeRecord.aggregate({ where: { memberId: id, deletedAt: null, transactionDate: { gte: yearStart } }, _sum: { amount: true } }) : null,
    ]);
    const seen = new Set(checkins.map((c) => Math.min(11, Math.floor((c.checkedInAt - since) / weekMs))));
    const giving = canMoney ? Number((tithes && tithes._sum.amount) || 0) + Number((income && income._sum.amount) || 0) : null;
    const name = `${m.firstName} ${m.lastName}`;
    const day = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
    const orgNames = m.orgMemberships.map((o) => o.organization.name);
    const avatar = memberAvatar({ photo_filename: m.photoFilename, first_name: m.firstName, last_name: m.lastName });
    const facts = [
      ['Phone', m.mobilePhone ? `<a href="tel:${esc(m.mobilePhone)}">${esc(m.mobilePhone)}</a>` : ''],
      ['Email', m.email ? `<a href="mailto:${esc(m.email)}">${esc(m.email)}</a>` : ''],
      ['Bible class', esc(m.bibleClass && m.bibleClass.name)],
      ['Day born', m.dayBorn ? `${esc(m.dayBorn)} <span class="muted-text">· ${esc(AKAN_NAMES[m.dayBorn] || '')}</span>` : ''],
      ['Date of birth', esc(fmtBirthday(m.dateOfBirth))],
      ['Member since', esc(day(m.joinDate))],
      ['Gender', m.gender ? esc(({ M: 'Male', F: 'Female', O: 'Other' })[m.gender] || m.gender) : ''],
      ['Emergency contact', m.emergencyContactName ? `${esc(m.emergencyContactName)}${m.emergencyContactPhone ? ` · <a href="tel:${esc(m.emergencyContactPhone)}">${esc(m.emergencyContactPhone)}</a>` : ''}` : ''],
    ].filter(([, v]) => v);
    const lastSeen = recent[0] ? recent[0].checkedInAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '—';

    res.send(`<div class="pp" data-member-name="${esc(name)}">
      <div class="pp-head">${avatar}<div><h2 id="ppTitle">${esc(name)}</h2>
        <div class="pp-chips"><span class="pill pill-${esc(m.membershipStatus.toLowerCase())}">${esc(MEMBER_STATUS_LABELS[m.membershipStatus] || m.membershipStatus)}</span>${orgNames.map((o) => `<span class="pm-chip">${esc(o)}</span>`).join('')}</div>
        <p>${[m.externalId, m.dayBorn ? `${m.dayBorn}-born` : '', m.joinDate ? `joined ${day(m.joinDate)}` : ''].filter(Boolean).map(esc).join(' · ')}</p></div></div>
      <div class="pp-actions">
        <a class="btn" href="/members/${m.id}">Open full profile</a>
        ${m.mobilePhone ? `<a class="btn ghost" href="tel:${esc(m.mobilePhone)}">${icon('phone')} Call</a>` : ''}
        ${isAdmin ? `<a class="btn ghost" href="/communications/broadcast?member_id=${m.id}">${icon('message')} SMS</a>` : ''}${canEdit ? `<a class="btn ghost" href="/members/${m.id}#edit">Edit</a>` : ''}
      </div>
      <div class="pp-trio">
        ${giving !== null ? `<div><small>Giving this year</small><b>${giving ? esc(`GH₵ ${Math.round(giving).toLocaleString('en-GH')}`) : '—'}</b></div>` : ''}
        <div><small>Attendance, 12 wks</small><b>${Math.round(seen.size / 12 * 100)}%</b></div>
        <div><small>Last seen</small><b>${esc(lastSeen)}</b></div>
      </div>
      <h3 class="pp-sec">Last 12 weeks</h3>
      <div class="pp-weeks">${Array.from({ length: 12 }, (_, i) => `<span${seen.has(i) ? ' class="on"' : ''}></span>`).join('')}</div>
      <div class="pp-weeks-l"><span>12 weeks ago</span><span>This week</span></div>
      ${facts.length ? `<h3 class="pp-sec">Details</h3><dl class="pp-facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>` : ''}
      <h3 class="pp-sec">Recent attendance</h3>
      ${recent.length ? `<ul class="pp-list">${recent.map((a) => `<li><span>${esc(a.event ? a.event.title : 'Check-in')}</span><small>${esc(a.checkedInAt.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }))}</small></li>`).join('')}</ul>` : '<p class="muted-text" style="margin:0">No check-ins recorded yet.</p>'}
      ${m.notes ? `<h3 class="pp-sec">Notes</h3><p class="pp-notes">${esc(m.notes)}</p>` : ''}
    </div>`);
  }));

  app.get('/members/:id', asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    const db = res.locals.db;
    const isAdmin = res.locals.user.role === 'ADMIN';
    const canEdit = isAdmin || res.locals.user.role === 'EDITOR';
    const id = Number(req.params.id);
    const m = await db.member.findFirst({ where: { id, deletedAt: null }, include: { bibleClass: { select: { name: true } } } });
    if (!m) return res.status(404).send('Not found');

    const [memberOrgsNamed, ministries, sacraments, attendance] = await Promise.all([
      db.organizationMembership.findMany({ where: { memberId: id }, include: { organization: { select: { id: true, name: true } } } }),
      db.ministryMembership.findMany({ where: { memberId: id, leftDate: null }, include: { ministry: { select: { name: true } } } }),
      db.sacrament.findMany({ where: { OR: [{ memberId: id }, { spouseId: id }] }, orderBy: { occurredOn: 'desc' } }),
      db.attendance.findMany({ where: { memberId: id }, include: { event: { select: { title: true, startsAt: true } } }, orderBy: { checkedInAt: 'desc' }, take: 10 }),
    ]);
    const memberOrgIds = memberOrgsNamed.map((o) => o.orgId);

    const photoControlsHtml = `
      <form method="post" action="/members/${id}/photo" enctype="multipart/form-data" class="photo-form">
        <input type="file" name="photo" accept="image/jpeg,image/png,image/webp,image/gif" required>
        <button type="submit">${m.photoFilename ? 'Replace photo' : 'Upload photo'}</button>
      </form>
      ${m.photoFilename ? `
        <form method="post" action="/members/${id}/photo/delete" data-confirm="Remove this photo?">
          <button class="link" type="submit">Remove photo</button>
        </form>` : ''}`;
    const body = renderMemberProfile({
      m, orgs: memberOrgsNamed, ministries, sacraments, attendance, isAdmin, canEdit,
      akanName: m.dayBorn ? (AKAN_NAMES[m.dayBorn] || '') : '',
      photoControlsHtml,
      editFormHtml: canEdit ? await memberForm(db, m, memberOrgIds, `/members/${id}`) : '',
    });
    res.page({ title: `${m.firstName} ${m.lastName}`, active: '/members', noHeader: true, body });
  }));

  app.post('/members/:id', requireEditor, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const id = Number(req.params.id);
    const b = req.body || {};
    const err = memberErrors(b);
    if (err) { flash(req, err); return res.redirect(`/members/${id}#edit`); }
    const orgIds = parseOrgIds(b);
    if (!(await validOrgIds(db, orgIds))) { flash(req, 'One or more organizations were not found.'); return res.redirect(`/members/${id}#edit`); }
    const bibleClassCheck = await checkBibleClassId(db, b.bibleClassId);
    if (!bibleClassCheck.ok) { flash(req, 'Bible class not found.'); return res.redirect(`/members/${id}#edit`); }
    try {
      await db.member.update({ where: { id }, data: { ...parseMemberBody(b), bibleClassId: bibleClassCheck.bibleClassId } });
    } catch (e) {
      if (e.code !== 'P2025') throw e;
      return res.status(404).send('Not found');
    }
    await saveMemberOrgs(db, id, orgIds);
    await logActivity(db, 'member_updated', `Member updated: ${b.firstName} ${b.lastName}`, `/members/${id}`, res.locals.user.id);
    res.redirect(`/members/${id}`);
  }));

  app.post('/members/:id/delete', requireAdmin, asyncHandler(async (req, res) => {
    try {
      const removed = await res.locals.db.member.update({ where: { id: Number(req.params.id) }, data: { deletedAt: new Date() } });
      await logActivity(res.locals.db, 'member_deleted',
        `Member removed: ${removed.firstName} ${removed.lastName}${removed.externalId ? ` (${removed.externalId})` : ''}`,
        '/members', res.locals.user.id);
    } catch (e) {
      if (e.code !== 'P2025') throw e;
    }
    res.redirect('/members');
  }));

  app.post('/members/:id/photo', requireEditor, photoUpload.single('photo'), asyncHandler(async (req, res) => {
    // Multipart bodies skip the global CSRF middleware (the body isn't parsed
    // yet when it runs), so the token is checked here, as /settings/logo does.
    if (!csrfValid(req)) return res.status(403).send('Security check failed. Refresh the page and try again.');
    const db = res.locals.db;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(404).send('Not found');
    // Confirm the member belongs to THIS church before touching the shared
    // photo directory: files are named by member id alone, so writing first
    // would let one church overwrite or delete another church's photo.
    const member = await db.member.findFirst({ where: { id }, select: { id: true } });
    if (!member) return res.status(404).send('Not found');
    if (!req.file) return res.redirect(`/members/${id}`);
    if (!looksLikeImage(req.file.buffer)) {
      return res.status(400).send(`<p>That file does not look like a valid image. Upload a JPG, PNG, WebP or GIF.</p><p><a href="/members/${id}">Back</a></p>`);
    }
    const ext = imageExt(req.file.buffer);
    const filename = `${id}.${ext}`;
    fs.writeFileSync(path.join(PHOTO_DIR, filename), req.file.buffer);
    // Remove any stale photos with other extensions for this member.
    for (const otherExt of Object.values(EXT_FROM_MIME)) {
      if (otherExt !== ext) {
        try { fs.unlinkSync(path.join(PHOTO_DIR, `${id}.${otherExt}`)); } catch (_) { /* didn't exist */ }
      }
    }
    await db.member.update({ where: { id }, data: { photoFilename: filename } });
    await logActivity(db, 'member_photo_updated', `Member photo updated for #${id}`, `/members/${id}`, res.locals.user.id);
    res.redirect(`/members/${id}`);
  }));

  app.post('/members/:id/photo/delete', requireEditor, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const id = Number(req.params.id);
    const m = await db.member.findFirst({ where: { id }, select: { photoFilename: true } });
    if (m && m.photoFilename) {
      try { fs.unlinkSync(path.join(PHOTO_DIR, m.photoFilename)); } catch (_) { /* already gone */ }
      await db.member.update({ where: { id }, data: { photoFilename: null } });
      await logActivity(db, 'member_photo_deleted', `Member photo removed for #${id}`, `/members/${id}`, res.locals.user.id);
    }
    res.redirect(`/members/${id}`);
  }));

  // Serve member photos. Cross-tenant check: only served if the requesting
  // user's own church actually has a member with this photoFilename — see
  // the module header for why this is necessary here but wasn't in the
  // single-tenant original.
  app.get('/photos/:filename', asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    const safe = req.params.filename.replace(/[^a-zA-Z0-9._-]/g, '');
    const owner = await res.locals.db.member.findFirst({ where: { photoFilename: safe }, select: { id: true } });
    if (!owner) return res.status(404).send('Not found');
    const full = path.join(PHOTO_DIR, safe);
    if (!fs.existsSync(full)) return res.status(404).send('Not found');
    res.sendFile(full);
  }));
}

module.exports = { register };
