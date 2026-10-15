'use strict';
// Platform › Churches at risk: churches gone quiet, churches that signed up
// and never got going, and every church's last sign-in, last activity and
// setup (lib/church-health.js), with the first admin's contact details so
// the operator can call, text, WhatsApp or email them.

const asyncHandler = require('../lib/async-handler');
const { esc } = require('../lib/format');
const { pageHero, statsRow, listCard, table } = require('../lib/views');
const { icon } = require('../lib/icons');
const { operatorLayout } = require('../lib/operator-shell');
const { requireOperator } = require('../lib/platform-operators');
const { healthReport, INACTIVE_DAYS, STARTED_MEMBERS } = require('../lib/church-health');

function page(res, opts) {
  return res.send(operatorLayout({ ...opts, operator: res.locals.operator, flash: res.locals.flash, flashType: res.locals.flashType }));
}

const isoDate = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
function ago(d, now) {
  if (!d) return '<span class="muted-text">never</span>';
  const days = Math.floor((now - new Date(d)) / 86400000);
  const text = days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
  return `${esc(isoDate(d))}<small>${esc(text)}</small>`;
}

function contact(owner) {
  if (!owner) return '<span class="muted-text">No admin</span>';
  const name = owner.displayName || owner.username;
  const digits = owner.phone ? owner.phone.replace(/\D/g, '') : '';
  const links = [
    owner.phone && `<a href="tel:${esc(owner.phone)}">Call</a>`,
    owner.phone && `<a href="https://wa.me/${esc(digits)}" target="_blank" rel="noopener">WhatsApp</a>`,
    owner.email && `<a href="mailto:${esc(owner.email)}">Email</a>`,
  ].filter(Boolean);
  return `<strong>${esc(name)}</strong><small>${esc(owner.phone || owner.email || '')}</small>${links.length ? `<small class="op-contact">${links.join(' · ')}</small>` : ''}`;
}

const churchCell = (c) => `<a class="platform-church-link" href="/platform/churches/${esc(c.id)}"><strong>${esc(c.name)}</strong><small>${esc(c.slug)} · ${esc(c.plan)}</small></a>`;
const setupCell = (c) => `${c.members} members<small>${c.events} events · ${c.users} staff</small>`;

async function renderHealth(req, res) {
  const now = new Date();
  const rows = await healthReport(now);
  const inactive = rows.filter((r) => r.inactive && !r.neverStarted).sort((a, b) => b.idleDays - a.idleDays);
  const notStarted = rows.filter((r) => r.neverStarted).sort((a, b) => a.members - b.members || b.ageDays - a.ageDays);
  const activeWeek = rows.filter((r) => r.idleDays !== null && r.idleDays < 7).length;

  const riskRows = (list) => list.map((c) => [churchCell(c), ago(c.lastSignIn, now), ago(c.lastActivity, now), setupCell(c), contact(c.owner)]);
  const all = [...rows].sort((a, b) => (b.idleDays ?? 0) - (a.idleDays ?? 0));

  const body = `
    ${pageHero('Churches at risk', 'Who has gone quiet, and who signed up but never got going, with someone to contact.')}
    ${statsRow([
      { cls: 'blue', icon: icon('platform'), value: rows.length.toLocaleString(), label: 'Active churches' },
      { cls: 'green', icon: icon('checkCircle'), value: activeWeek.toLocaleString(), label: 'Used in the last 7 days' },
      { cls: 'gold', icon: icon('clock'), value: inactive.length.toLocaleString(), label: `Quiet for ${INACTIVE_DAYS}+ days` },
      { cls: 'purple', icon: icon('userPlus'), value: notStarted.length.toLocaleString(), label: 'Never got started' },
    ])}
    ${listCard({
      title: `Quiet for ${INACTIVE_DAYS} days or more`, count: inactive.length, countLabel: inactive.length === 1 ? 'church' : 'churches',
      note: 'No sign-in and nothing done in the app. Longest first.',
      inner: inactive.length ? table(['Church', 'Last sign-in', 'Last activity', 'Setup', 'Contact'], riskRows(inactive), { keyCols: 2 }) : '<p class="muted-text">Every church has been active in the last month.</p>',
    })}
    ${listCard({
      title: 'Never got started', count: notStarted.length, countLabel: notStarted.length === 1 ? 'church' : 'churches',
      note: `Signed up a week or more ago, with fewer than ${STARTED_MEMBERS} members. A call to help them set up usually decides whether they stay.`,
      inner: notStarted.length ? table(['Church', 'Last sign-in', 'Last activity', 'Setup', 'Contact'], riskRows(notStarted), { keyCols: 2 }) : '<p class="muted-text">Every church past its first week has members in.</p>',
    })}
    ${listCard({
      title: 'Every church', count: all.length, countLabel: all.length === 1 ? 'church' : 'churches',
      note: 'Least recently used first.',
      inner: table(['Church', 'Signed up', 'Last sign-in', 'Last activity', 'Setup'], all.map((c) => [churchCell(c), esc(isoDate(c.createdAt)), ago(c.lastSignIn, now), ago(c.lastActivity, now), setupCell(c)]), { keyCols: 2 }),
    })}`;
  page(res, { title: 'Churches at risk', active: '/platform/health', body });
}

function register(app) {
  app.get('/platform/health', requireOperator, asyncHandler(renderHealth));
}

module.exports = { register };
