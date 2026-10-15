'use strict';
// Platform growth for the console's Overview: for each of the last 12
// months, churches that signed up, churches that moved to Pro, and churches
// deleted. A Pro upgrade is a "platform.plan_upgraded" event in the church's
// security log or its pro_since date (whichever exists), counted once per
// church per month, so upgrades from before this chart existed count too.

const { db } = require('./tenant');

const monthKey = (d) => new Date(d).toISOString().slice(0, 7);

function lastMonths(now = new Date(), n = 12) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))));
  return out;
}

async function growthByMonth(now = new Date()) {
  const months = lastMonths(now);
  const since = new Date(`${months[0]}-01T00:00:00Z`);
  const [signups, deleted, upgradeEvents, proSince] = await Promise.all([
    db.church.findMany({ where: { createdAt: { gte: since } }, select: { createdAt: true } }),
    db.church.findMany({ where: { deletedAt: { gte: since } }, select: { deletedAt: true } }),
    db.securityAuditLog.findMany({ where: { event: 'platform.plan_upgraded', occurredAt: { gte: since } }, select: { churchId: true, occurredAt: true } }),
    db.church.findMany({ where: { proSince: { gte: since } }, select: { id: true, proSince: true } }),
  ]);
  const rows = Object.fromEntries(months.map((m) => [m, { month: m, signups: 0, upgrades: 0, deleted: 0 }]));
  for (const c of signups) { const m = monthKey(c.createdAt); if (rows[m]) rows[m].signups += 1; }
  for (const c of deleted) { const m = monthKey(c.deletedAt); if (rows[m]) rows[m].deleted += 1; }
  const upgraded = new Set();
  for (const e of upgradeEvents) upgraded.add(`${e.churchId}|${monthKey(e.occurredAt)}`);
  for (const c of proSince) upgraded.add(`${c.id}|${monthKey(c.proSince)}`);
  for (const key of upgraded) { const m = key.split('|')[1]; if (rows[m]) rows[m].upgrades += 1; }
  return months.map((m) => rows[m]);
}

module.exports = { growthByMonth, lastMonths };
