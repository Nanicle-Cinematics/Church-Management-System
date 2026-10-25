'use strict';
// Platform › Churches at risk: how each church is using the app, to find the
// ones to call. For every active church (not suspended or deleted):
//   last sign-in  - the latest successful sign-in in its security log
//                   (auth.login_succeeded / auth.mfa_*), so history from
//                   before users.last_login_at existed counts too
//   last activity - its latest activity-feed entry (anything staff did)
//   setup         - members, events and staff accounts
// and two lists: inactive (no sign-in and no activity for 30 days) and
// never got started (a week or more since signing up, fewer than 5 members).

const { db } = require('./tenant');

const DAY_MS = 24 * 60 * 60 * 1000;
const INACTIVE_DAYS = 30;
const STARTED_MEMBERS = 5;
const SIGN_IN_EVENTS = ['auth.login_succeeded', 'auth.mfa_succeeded', 'auth.mfa_recovery_succeeded'];

const toMap = (rows, value) => new Map(rows.map((r) => [r.churchId, value(r)]));

async function healthReport(now = new Date()) {
  const churches = await db.church.findMany({
    where: { deletedAt: null, suspendedAt: null },
    select: { id: true, name: true, slug: true, plan: true, proUntil: true, createdAt: true },
  });
  const [signIns, activity, members, events, users, owners] = await Promise.all([
    db.securityAuditLog.groupBy({ by: ['churchId'], where: { event: { in: SIGN_IN_EVENTS } }, _max: { occurredAt: true } }),
    db.activityLog.groupBy({ by: ['churchId'], _max: { occurredAt: true } }),
    db.member.groupBy({ by: ['churchId'], where: { deletedAt: null }, _count: { _all: true } }),
    db.event.groupBy({ by: ['churchId'], _count: { _all: true } }),
    db.user.groupBy({ by: ['churchId'], where: { deletedAt: null }, _count: { _all: true } }),
    // The first admin: the person who signed the church up, usually.
    db.user.findMany({
      where: { role: 'ADMIN', deletedAt: null }, orderBy: { id: 'asc' },
      select: { churchId: true, displayName: true, username: true, email: true, phone: true },
    }),
  ]);
  const lastSignIn = toMap(signIns, (r) => r._max.occurredAt);
  const lastActivity = toMap(activity, (r) => r._max.occurredAt);
  const memberCount = toMap(members, (r) => r._count._all);
  const eventCount = toMap(events, (r) => r._count._all);
  const userCount = toMap(users, (r) => r._count._all);
  const owner = new Map();
  for (const u of owners) if (!owner.has(u.churchId)) owner.set(u.churchId, u);

  const days = (d) => (d ? Math.floor((now - new Date(d)) / DAY_MS) : null);
  return churches.map((c) => {
    const signIn = lastSignIn.get(c.id) || null;
    const act = lastActivity.get(c.id) || null;
    const latest = [signIn, act].filter(Boolean).sort((a, b) => b - a)[0] || null;
    const age = days(c.createdAt);
    const row = {
      ...c,
      lastSignIn: signIn, lastActivity: act,
      idleDays: latest ? days(latest) : age,
      ageDays: age,
      members: memberCount.get(c.id) || 0,
      events: eventCount.get(c.id) || 0,
      users: userCount.get(c.id) || 0,
      owner: owner.get(c.id) || null,
    };
    row.inactive = row.idleDays >= INACTIVE_DAYS;
    row.neverStarted = age >= 7 && row.members < STARTED_MEMBERS;
    return row;
  });
}

module.exports = { healthReport, INACTIVE_DAYS, STARTED_MEMBERS, SIGN_IN_EVENTS };
