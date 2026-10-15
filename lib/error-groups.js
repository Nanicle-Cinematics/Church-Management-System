'use strict';
// Platform › Errors: the error log grouped, so one fault seen a hundred
// times is one line. Errors group by method, path (with ids and numbers
// replaced) and message (with numbers, ids and quoted values replaced).
// Marking a group fixed stamps its open rows; if the fault happens again the
// group reappears as open and is flagged as having come back.

const { db } = require('./tenant');

const DAY_MS = 24 * 60 * 60 * 1000;

function normalizePath(p) {
  return String(p || '')
    .split('?')[0]
    .replace(/\/c[a-z0-9]{20,}/g, '/:id') // cuid church ids
    .replace(/\/[0-9a-f]{24,}/gi, '/:token')
    .replace(/\/\d+/g, '/:id');
}

function normalizeMessage(m) {
  return String(m || '')
    .split('\n')[0]
    .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, '…')
    .replace(/\bc[a-z0-9]{20,}\b/g, '…')
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27}\b/gi, '…')
    .replace(/\d+/g, 'N')
    .slice(0, 200);
}

const fingerprint = (e) => `${e.method || ''} ${normalizePath(e.path)} | ${normalizeMessage(e.message)}`;

/** Groups over the last `days` days. `show`: 'open' (default) or 'fixed'. */
async function errorGroups({ days = 90, show = 'open', now = new Date() } = {}) {
  const rows = await db.errorLog.findMany({
    where: { occurredAt: { gte: new Date(now.getTime() - days * DAY_MS) } },
    orderBy: { occurredAt: 'desc' },
    take: 5000,
    select: { id: true, occurredAt: true, method: true, path: true, message: true, stack: true, churchId: true, resolvedAt: true, resolvedBy: true },
  });
  const groups = new Map();
  for (const e of rows) {
    const key = fingerprint(e);
    let g = groups.get(key);
    if (!g) {
      g = { key, method: e.method, path: normalizePath(e.path), message: normalizeMessage(e.message), sample: e, open: 0, fixed: 0, churches: new Set(), first: e.occurredAt, last: e.occurredAt, resolvedAt: null, resolvedBy: null };
      groups.set(key, g);
    }
    if (e.resolvedAt) {
      g.fixed += 1;
      if (!g.resolvedAt || e.resolvedAt > g.resolvedAt) { g.resolvedAt = e.resolvedAt; g.resolvedBy = e.resolvedBy; }
    } else g.open += 1;
    if (e.churchId) g.churches.add(e.churchId);
    if (e.occurredAt < g.first) g.first = e.occurredAt;
  }
  const list = [...groups.values()].map((g) => ({ ...g, churches: g.churches.size, cameBack: g.open > 0 && g.fixed > 0 }));
  return list
    .filter((g) => (show === 'fixed' ? g.open === 0 : g.open > 0))
    .sort((a, b) => b.last - a.last);
}

/** Mark every open error in a group fixed. Returns how many. */
async function resolveGroup(key, operatorEmail, { days = 90, now = new Date() } = {}) {
  const rows = await db.errorLog.findMany({
    where: { resolvedAt: null, occurredAt: { gte: new Date(now.getTime() - days * DAY_MS) } },
    select: { id: true, method: true, path: true, message: true },
    take: 5000,
  });
  const ids = rows.filter((e) => fingerprint(e) === key).map((e) => e.id);
  if (!ids.length) return 0;
  const r = await db.errorLog.updateMany({ where: { id: { in: ids } }, data: { resolvedAt: now, resolvedBy: operatorEmail } });
  return r.count;
}

module.exports = { errorGroups, resolveGroup, fingerprint, normalizePath, normalizeMessage };
