'use strict';
// Platform announcements (Platform › Announcements): a notice shown at the
// top of every signed-in church page while it runs, e.g. planned
// maintenance. Optionally emailed once to every church's admins.
//
// Page rendering is synchronous (lib/shell.js), so the running notices are
// kept in memory and refreshed in the background at most once a minute, and
// at once whenever an operator changes them. A notice therefore appears
// within a minute on every app machine.

const { db } = require('./tenant');
const { sendOpsEmail } = require('./delivery');

const TTL_MS = 60 * 1000;
let cache = [];
let loadedAt = 0;
let loading = null;

async function refresh() {
  if (loading) return loading;
  loading = (async () => {
    try {
      const now = new Date();
      cache = await db.platformAnnouncement.findMany({
        where: { startsAt: { lte: now }, OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
        orderBy: { startsAt: 'desc' },
        select: { id: true, message: true, level: true, startsAt: true, endsAt: true },
      });
      loadedAt = Date.now();
    } catch (e) {
      console.error('[announcements] refresh failed:', e.message);
    } finally {
      loading = null;
    }
    return cache;
  })();
  return loading;
}

/** The notices running now, for the page frame. Never waits on the database. */
function activeAnnouncements() {
  if (Date.now() - loadedAt > TTL_MS) refresh();
  const now = new Date();
  return cache.filter((a) => new Date(a.startsAt) <= now && (!a.endsAt || new Date(a.endsAt) > now));
}

/**
 * Email a notice to every active church's admins, one message each (so no
 * one sees the others' addresses). Runs in the background; returns the count.
 */
async function emailAnnouncement(announcement) {
  const admins = await db.user.findMany({
    where: { role: 'ADMIN', deletedAt: null, email: { not: null }, church: { deletedAt: null, suspendedAt: null } },
    select: { email: true },
  });
  const addresses = [...new Set(admins.map((a) => a.email).filter((e) => e.includes('@')))];
  let sent = 0;
  for (const to of addresses) {
    const r = await sendOpsEmail(to, 'A notice from Church Manager', `${announcement.message}\n\nChurch Manager`);
    if (r.ok) sent += 1;
  }
  await db.platformAnnouncement.update({ where: { id: announcement.id }, data: { emailedAt: new Date() } });
  return { recipients: addresses.length, sent };
}

module.exports = { activeAnnouncements, refresh, emailAnnouncement };
