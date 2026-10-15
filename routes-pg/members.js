'use strict';
// Phase 3, module 3 of 3 (last of Phase 3): Postgres/Prisma port of
// routes/members.js. Same coexistence approach as the other routes-pg/*.js
// modules — Members is the entity most other tables FK to, done last within
// Phase 3 once the pattern was well-proven on 7 simpler modules.
//
// SCOPE: core member CRUD + directly-owned relations (organization
// memberships, active ministry memberships, sacraments, recent attendance).
// DEFERRED (documented, not forgotten):
// - CSV export/import, bulk actions, the absent-members report+notify —
//   cross-cutting file-format/external-send concerns, same reasoning as
//   attendance.csv and communications' real SMS/email delivery.
// - Photo upload/storage — blocked on the file-storage vendor decision
//   (Vercel Blob vs Fly volume) flagged as an open decision in the plan.
// - The detail page's giving/pledges/activity timeline — those pull in
//   Finance models (Tithe/SpecialOffering/Pledge/ActivityLog) that belong
//   to Phase 5 (finance, deliberately last) and a not-yet-built audit-log
//   write path used by every original module (logActivity() calls exist
//   throughout routes/*.js but haven't been ported anywhere in Phase 2/3 —
//   worth doing as its own uniform pass before the real cutover, not
//   per-module).

const asyncHandler = require('../lib/async-handler');
const { pickEnum, cleanDate, memberFieldError, createMemberWithId, GENDERS, MARITAL_STATUSES: MARITAL_ENUM, PREFERRED_CHANNELS } = require('../lib/member-input');

const MEMBERSHIP_STATUSES = ['VISITOR', 'REGULAR', 'MEMBER', 'DISTANT', 'INACTIVE', 'TRANSFERRED', 'DECEASED', 'OTHER'];
const MEMBERS_PER_PAGE = 25;
const MEMBER_ID_PREFIX = 'MBR';

function requireAdmin(req, res, next) {
  if (res.locals.user && res.locals.user.role === 'ADMIN') return next();
  return res.status(403).json({ error: 'forbidden' });
}
// Editors can add and edit; deleting, archiving and anything that sends
// messages stays with admins.
function requireEditor(req, res, next) {
  if (res.locals.user && ['ADMIN', 'EDITOR'].includes(res.locals.user.role)) return next();
  return res.status(403).json({ error: 'forbidden' });
}

function requireAuth(req, res, next) {
  if (!res.locals.user) return res.status(401).json({ error: 'not logged in' });
  next();
}

// The unsubscribe token is a credential (anyone holding it can opt that member
// out), so it is never returned to API clients.
function publicMember(m) {
  if (!m) return m;
  const { unsubscribeToken, ...rest } = m; // eslint-disable-line no-unused-vars
  return rest;
}

function isEmailish(s) { return !s || /^\S+@\S+\.\S+$/.test(s); }
function isPhoneish(s) { return !s || /\d{7,}/.test(String(s).replace(/\D/g, '')); }

function memberErrors(b) {
  if (!b.firstName || !String(b.firstName).trim()) return 'First name is required.';
  if (!b.lastName || !String(b.lastName).trim()) return 'Last name is required.';
  if (b.email && !isEmailish(b.email)) return 'Enter a valid email address, or leave it blank.';
  if (b.mobilePhone && !isPhoneish(b.mobilePhone)) return 'Enter a valid mobile number (at least 7 digits).';
  return memberFieldError(b);
}

async function nextMemberId(db) {
  // Tenant-scoped automatically — the scoped client only sees this
  // church's members, so numbering restarts at MBR-001 per church.
  const rows = await db.member.findMany({
    where: { externalId: { startsWith: `${MEMBER_ID_PREFIX}-` } },
    select: { externalId: true },
  });
  let max = 0;
  for (const r of rows) {
    const m = /-(\d+)$/.exec(r.externalId || '');
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${MEMBER_ID_PREFIX}-${String(max + 1).padStart(3, '0')}`;
}

function parseMemberBody(b) {
  return {
    bibleClassId: b.bibleClassId ? Number(b.bibleClassId) : null,
    firstName: (b.firstName || '').trim(),
    lastName: (b.lastName || '').trim(),
    email: (b.email || '').trim() || null,
    mobilePhone: (b.mobilePhone || '').trim() || null,
    dateOfBirth: cleanDate(b.dateOfBirth),
    dayBorn: b.dayBorn || null,
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

// createMany only stamps churchId onto each new row — it does not verify that
// a client-supplied orgId belongs to this tenant, so callers must validate
// orgIds through the scoped client (see validOrgIds below) before calling
// this, or a cross-tenant orgId in the request body would silently link the
// member into another church's organization roster.
async function saveMemberOrgs(db, memberId, orgIds) {
  await db.organizationMembership.deleteMany({ where: { memberId } });
  if (orgIds.length) {
    await db.organizationMembership.createMany({ data: orgIds.map((orgId) => ({ orgId, memberId })) });
  }
}

/** Returns true only if every id in orgIds resolves to an organization in this tenant. */
async function validOrgIds(db, orgIds) {
  if (!orgIds.length) return true;
  const found = await db.organization.count({ where: { id: { in: orgIds } } });
  return found === new Set(orgIds).size;
}

// Same tenant-validation as validOrgIds, for Member.bibleClassId — a
// client-supplied id must be checked through the scoped client, or a
// cross-tenant id would silently link this member to another church's
// bible class ("Ministry" model).
async function checkBibleClassId(db, bodyBibleClassId) {
  if (!bodyBibleClassId) return { ok: true, bibleClassId: null };
  const ministry = await db.ministry.findUnique({ where: { id: Number(bodyBibleClassId) } });
  return ministry ? { ok: true, bibleClassId: ministry.id } : { ok: false, bibleClassId: null };
}

function register(app) {
  app.get('/api/members', requireAuth, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const q = (req.query.q || '').trim();
    const status = MEMBERSHIP_STATUSES.includes(req.query.status) ? req.query.status : null;
    const classId = req.query.classId ? Number(req.query.classId) : null;
    const dayBorn = (req.query.dayBorn || '').trim() || null;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);

    const where = {
      deletedAt: null,
      ...(status ? { membershipStatus: status } : {}),
      ...(classId ? { bibleClassId: classId } : {}),
      ...(dayBorn ? { dayBorn } : {}),
      ...(q ? {
        OR: [
          { firstName: { contains: q, mode: 'insensitive' } },
          { lastName: { contains: q, mode: 'insensitive' } },
          { email: { contains: q, mode: 'insensitive' } },
          { mobilePhone: { contains: q } },
          { externalId: { contains: q, mode: 'insensitive' } },
        ],
      } : {}),
    };

    const [total, rows] = await Promise.all([
      db.member.count({ where }),
      db.member.findMany({
        where,
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
        take: MEMBERS_PER_PAGE,
        skip: (page - 1) * MEMBERS_PER_PAGE,
        include: { bibleClass: { select: { name: true } } },
      }),
    ]);
    res.json({ total, page, pages: Math.max(1, Math.ceil(total / MEMBERS_PER_PAGE)), members: rows.map(publicMember) });
  }));

  app.post('/api/members', requireEditor, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const b = req.body || {};
    const err = memberErrors(b);
    if (err) return res.status(400).json({ error: err });
    const orgIds = Array.isArray(b.orgIds) ? b.orgIds.map(Number).filter(Boolean) : [];
    if (!(await validOrgIds(db, orgIds))) return res.status(400).json({ error: 'One or more organizations were not found' });
    const bibleClassCheck = await checkBibleClassId(db, b.bibleClassId);
    if (!bibleClassCheck.ok) return res.status(400).json({ error: 'Bible class not found' });
    const member = await createMemberWithId(db, { ...parseMemberBody(b), bibleClassId: bibleClassCheck.bibleClassId });
    if (orgIds.length) await saveMemberOrgs(db, member.id, orgIds);
    res.status(201).json(publicMember(member));
  }));

  app.get('/api/members/:id', requireAuth, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const id = Number(req.params.id);
    const member = await db.member.findFirst({
      where: { id, deletedAt: null },
      include: { bibleClass: { select: { id: true, name: true } } },
    });
    if (!member) return res.status(404).json({ error: 'Not found' });

    const [orgMemberships, ministryMemberships, sacraments, attendance] = await Promise.all([
      db.organizationMembership.findMany({ where: { memberId: id }, include: { organization: { select: { id: true, name: true } } } }),
      db.ministryMembership.findMany({ where: { memberId: id, leftDate: null }, include: { ministry: { select: { name: true } } } }),
      db.sacrament.findMany({ where: { OR: [{ memberId: id }, { spouseId: id }] }, orderBy: { occurredOn: 'desc' } }),
      db.attendance.findMany({
        where: { memberId: id },
        include: { event: { select: { title: true, startsAt: true } } },
        orderBy: { checkedInAt: 'desc' },
        take: 10,
      }),
    ]);

    res.json({
      ...publicMember(member),
      organizations: orgMemberships.map((m) => m.organization),
      ministries: ministryMemberships.map((m) => ({ name: m.ministry.name, role: m.role, joinedDate: m.joinedDate })),
      sacraments,
      recentAttendance: attendance.map((a) => ({ title: a.event.title, startsAt: a.event.startsAt })),
    });
  }));

  app.put('/api/members/:id', requireEditor, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const id = Number(req.params.id);
    const b = req.body || {};
    const err = memberErrors(b);
    if (err) return res.status(400).json({ error: err });
    const orgIds = Array.isArray(b.orgIds) ? b.orgIds.map(Number).filter(Boolean) : [];
    if (!(await validOrgIds(db, orgIds))) return res.status(400).json({ error: 'One or more organizations were not found' });
    const bibleClassCheck = await checkBibleClassId(db, b.bibleClassId);
    if (!bibleClassCheck.ok) return res.status(400).json({ error: 'Bible class not found' });
    try {
      const member = await db.member.update({ where: { id }, data: { ...parseMemberBody(b), bibleClassId: bibleClassCheck.bibleClassId } });
      await saveMemberOrgs(db, id, orgIds);
      res.json(publicMember(member));
    } catch (e) {
      if (e.code === 'P2025') return res.status(404).json({ error: 'Not found' });
      throw e;
    }
  }));

  app.delete('/api/members/:id', requireAdmin, asyncHandler(async (req, res) => {
    try {
      await res.locals.db.member.update({ where: { id: Number(req.params.id) }, data: { deletedAt: new Date() } });
      res.status(204).end();
    } catch (e) {
      if (e.code === 'P2025') return res.status(404).json({ error: 'Not found' });
      throw e;
    }
  }));
}

module.exports = { register };
