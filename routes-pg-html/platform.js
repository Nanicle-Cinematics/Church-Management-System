'use strict';
// Cross-tenant SaaS-owner portal. This is the one intentionally unscoped
// HTML surface in the app; every handler is gated before touching rawDb.

const asyncHandler = require('../lib/async-handler');
const { esc } = require('../lib/format');
const { pageHero, statsRow, listCard, table } = require('../lib/views');
const { flash } = require('../lib/tenant-flash');
const { db: rawDb } = require('../lib/tenant');
const { isPro } = require('../routes-pg/settings');
const { requestIp, requestUserAgent } = require('../lib/security-audit');
const { icon } = require('../lib/icons');
const { operatorLayout } = require('../lib/operator-shell');
const { requireOperator, logPlatformEvent } = require('../lib/platform-operators');
const { releaseChurchEmails, reclaimChurchEmails } = require('../lib/church-emails');
const { renewalsOverview, extendedUntil } = require('../lib/pro-renewals');
const { balanceState, balanceThreshold } = require('../lib/sms-balance');
const { healthReport } = require('../lib/church-health');
const { growthByMonth } = require('../lib/platform-growth');
const { accessOpen } = require('../lib/support-view');

// Operators only (lib/platform-operators.js): church users never get here.
function page(res, opts) {
  return res.send(operatorLayout({
    ...opts, operator: res.locals.operator, flash: res.locals.flash, flashType: res.locals.flashType,
  }));
}

function isoDate(value) {
  return value ? value.toISOString().slice(0, 10) : '—';
}

function dateTime(value) {
  return value ? value.toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }) : '—';
}

function accessState(church) {
  if (church.deletedAt) return 'deleted';
  if (church.suspendedAt) return 'suspended';
  return 'active';
}

function planPill(church) {
  return isPro(church)
    ? '<span class="pill pill-fulfilled">Pro</span>'
    : '<span class="pill pill-pending">Free</span>';
}

function accessPill(church) {
  const state = accessState(church);
  if (state === 'deleted') return '<span class="pill pill-overdue">Deleted</span>';
  if (state === 'suspended') return '<span class="pill pill-overdue">Suspended</span>';
  return '<span class="pill pill-fulfilled">Active</span>';
}

function platformReturn(req, fallback = '/platform') {
  const ref = String(req.get('referer') || '');
  try {
    const url = new URL(ref);
    const host = String(req.get('host') || '');
    if (url.host === host && (url.pathname === '/platform' || url.pathname.startsWith('/platform/'))) {
      return `${url.pathname}${url.search}`;
    }
  } catch (_) {}
  return fallback;
}

function buildChurchWhere(query) {
  const q = String(query.q || '').trim();
  const plan = String(query.plan || 'all');
  const status = String(query.status || 'all');
  const where = {};
  const and = [];

  if (q) {
    and.push({
      OR: [
        { name: { contains: q, mode: 'insensitive' } },
        { slug: { contains: q, mode: 'insensitive' } },
      ],
    });
  }
  if (plan === 'free' || plan === 'pro') and.push({ plan });
  if (status === 'active') and.push({ suspendedAt: null, deletedAt: null });
  if (status === 'suspended') and.push({ suspendedAt: { not: null }, deletedAt: null });
  if (status === 'deleted') and.push({ deletedAt: { not: null } });
  if (and.length) where.AND = and;
  return where;
}

function portalFilters(query) {
  const q = esc(query.q || '');
  const plan = String(query.plan || 'all');
  const status = String(query.status || 'all');
  const selected = (value, current) => value === current ? 'selected' : '';
  return `<div class="card platform-filters">
    <div class="card-head"><h2>Find churches</h2><span class="meta">Search tenants, plans and access states</span></div>
    <form method="get" action="/platform" class="filter-bar">
      <div class="search-field"><span aria-hidden="true">🔎</span>
        <input type="search" name="q" value="${q}" placeholder="Search church name or slug">
      </div>
      <select name="plan" aria-label="Plan">
        <option value="all" ${selected('all', plan)}>All plans</option>
        <option value="free" ${selected('free', plan)}>Free</option>
        <option value="pro" ${selected('pro', plan)}>Pro</option>
      </select>
      <select name="status" aria-label="Access status">
        <option value="all" ${selected('all', status)}>All statuses</option>
        <option value="active" ${selected('active', status)}>Active</option>
        <option value="suspended" ${selected('suspended', status)}>Suspended</option>
        <option value="deleted" ${selected('deleted', status)}>Deleted</option>
      </select>
      <button type="submit">Apply</button>
      <a class="btn ghost" href="/platform">Reset</a>
    </form>
  </div>`;
}

function quickControls(church, compact = false) {
  const months = `<input type="number" name="months" placeholder="months" min="1" ${compact ? '' : 'style="width:88px"'}>`;
  const planForm = `<form method="post" action="/platform/churches/${church.id}/plan" class="inline platform-inline-form">
    <select name="plan">
      <option value="free" ${church.plan === 'free' ? 'selected' : ''}>free</option>
      <option value="pro" ${church.plan === 'pro' ? 'selected' : ''}>pro</option>
    </select>
    ${months}
    <button type="submit">${church.plan === 'pro' ? 'Update plan' : 'Upgrade'}</button>
  </form>`;

  if (church.deletedAt) {
    return `${planForm}<form method="post" action="/platform/churches/${church.id}/access" class="inline platform-inline-form">
      <input type="hidden" name="action" value="restore">
      <button type="submit">Restore church</button>
    </form>`;
  }
  if (church.suspendedAt) {
    return `${planForm}<form method="post" action="/platform/churches/${church.id}/access" class="inline platform-inline-form">
      <input type="hidden" name="action" value="reactivate">
      <button type="submit">Reactivate</button>
    </form>`;
  }
  return `${planForm}<form method="post" action="/platform/churches/${church.id}/access" class="inline platform-inline-form"
      onsubmit="return confirm('Suspend access for this church? Its users will be blocked immediately.')">
      <input type="hidden" name="action" value="suspend">
      <input name="reason" required maxlength="500" placeholder="Suspension reason">
      <button type="submit" class="danger">Suspend</button>
    </form>
    <form method="post" action="/platform/churches/${church.id}/access" class="inline platform-inline-form"
      onsubmit="return confirm('Delete this church? Access is blocked immediately and its login emails are freed for reuse. It can be restored for 30 days.')">
      <input type="hidden" name="action" value="delete">
      <input name="confirmSlug" required placeholder="Type ${esc(church.slug)}">
      <input name="reason" required maxlength="500" placeholder="Deletion reason">
      <button type="submit" class="danger">Delete</button>
    </form>`;
}

async function platformStats() {
  const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [
    churchCount, userCount, memberCount, proCount, suspendedCount, deletedCount,
    recentChurches, trialCount, openErrors,
  ] = await Promise.all([
    rawDb.church.count(),
    rawDb.user.count({ where: { deletedAt: null } }),
    rawDb.member.count({ where: { deletedAt: null } }),
    rawDb.church.count({ where: { plan: 'pro' } }),
    rawDb.church.count({ where: { suspendedAt: { not: null }, deletedAt: null } }),
    rawDb.church.count({ where: { deletedAt: { not: null } } }),
    rawDb.church.count({ where: { createdAt: { gte: since30 } } }),
    rawDb.trialSignup.count().catch(() => 0),
    rawDb.errorLog.count({ where: { occurredAt: { gte: since30 }, resolvedAt: null } }).catch(() => 0),
  ]);
  return {
    churchCount, userCount, memberCount, proCount, suspendedCount, deletedCount,
    activeCount: Math.max(0, churchCount - suspendedCount - deletedCount),
    recentChurches, trialCount, openErrors,
  };
}

function ownerSummaryCards(stats, sms = {}, atRisk = 0) {
  return `${statsRow([
    { cls: 'gold', icon: icon('platform'), value: stats.churchCount.toLocaleString(), label: 'Churches onboarded' },
    { cls: 'green', icon: icon('attendance'), value: stats.activeCount.toLocaleString(), label: 'Active churches' },
    { cls: 'blue', icon: icon('star'), value: stats.proCount.toLocaleString(), label: 'Pro churches' },
    { cls: 'purple', icon: icon('members'), value: stats.memberCount.toLocaleString(), label: 'Members managed' },
  ])}
  <div class="platform-mini-grid">
    <div><strong>${stats.userCount.toLocaleString()}</strong><span>Total staff users</span></div>
    <div><strong>${stats.recentChurches.toLocaleString()}</strong><span>New churches in 30 days</span></div>
    <div><strong>${stats.suspendedCount.toLocaleString()}</strong><span>Suspended churches</span></div>
    <div><strong>${stats.deletedCount.toLocaleString()}</strong><span>Deleted churches</span></div>
    <div><strong>${stats.trialCount.toLocaleString()}</strong><span>Trial enquiries</span></div>
    <div><strong>${stats.openErrors.toLocaleString()}</strong><span><a href="/platform/errors">Open errors</a> in 30 days</span></div>
    <div${atRisk ? ' class="op-mini-low"' : ''}><strong>${atRisk.toLocaleString()}</strong><span><a href="/platform/health">Churches at risk</a></span></div>
    <div${sms.low ? ' class="op-mini-low"' : ''}><strong>${sms.balance === null || sms.balance === undefined ? '—' : Number(sms.balance).toLocaleString('en-GB')}</strong><span><a href="/platform/sms">SMS balance</a>${sms.low ? ' · low' : ''}</span></div>
  </div>`;
}

// Sign-ups and Pro upgrades for each of the last 12 months (lib/platform-growth.js).
function growthCard(growth) {
  const max = Math.max(1, ...growth.map((g) => Math.max(g.signups, g.upgrades)));
  const h = (n) => (n ? Math.max(4, Math.round((n / max) * 100)) : 0);
  const label = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' });
  const signups = growth.reduce((n, g) => n + g.signups, 0);
  const upgrades = growth.reduce((n, g) => n + g.upgrades, 0);
  const deleted = growth.reduce((n, g) => n + g.deleted, 0);
  return `
    <section class="card op-growth">
      <div class="card-head"><h2>Growth · last 12 months</h2>
        <span class="meta"><span class="op-key op-key-a"></span>Sign-ups ${signups} <span class="op-key op-key-b"></span>Pro upgrades ${upgrades}${deleted ? ` · ${deleted} deleted` : ''}${signups ? ` · ${Math.round((upgrades / signups) * 100)}% upgrade rate` : ''}</span></div>
      <div class="op-bars" role="img" aria-label="Sign-ups and Pro upgrades for each of the last 12 months">${growth.map((g) => `
        <div class="op-bar" title="${esc(label(g.month))}: ${g.signups} sign-up${g.signups === 1 ? '' : 's'}, ${g.upgrades} Pro upgrade${g.upgrades === 1 ? '' : 's'}"><span class="op-pair"><span style="height:${h(g.signups)}%"></span><span class="b" style="height:${h(g.upgrades)}%"></span></span><small>${esc(label(g.month))}</small></div>`).join('')}</div>
      <details><summary>Numbers</summary>${table(['Month', 'Sign-ups', 'Pro upgrades', 'Deleted'], growth.map((g) => [esc(g.month), String(g.signups), String(g.upgrades), String(g.deleted)]), { keyCols: 1 })}</details>
    </section>`;
}

async function renderPlatformIndex(req, res) {
  const where = buildChurchWhere(req.query || {});
  const [stats, churches, recentAudit, recentErrors, senderRequests, renewals, smsState, smsThreshold, health, growth] = await Promise.all([
    platformStats(),
    rawDb.church.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 250,
      include: { _count: { select: { users: true, members: true, events: true, broadcasts: true } } },
    }),
    rawDb.platformAuditLog.findMany({ orderBy: { occurredAt: 'desc' }, take: 10 }),
    rawDb.errorLog.findMany({
      orderBy: { occurredAt: 'desc' },
      take: 6,
      include: { church: { select: { name: true, slug: true } } },
    }).catch(() => []),
    rawDb.church.findMany({
      where: { smsSenderStatus: 'PENDING', deletedAt: null },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, slug: true, smsSenderId: true },
    }),
    renewalsOverview(),
    balanceState().catch(() => null),
    balanceThreshold().catch(() => 200),
    healthReport().catch(() => []),
    growthByMonth().catch(() => []),
  ]);
  const atRisk = health.filter((h) => h.inactive || h.neverStarted).length;
  const smsBalance = smsState ? smsState.balance : null;
  const sms = { balance: smsBalance, low: smsBalance !== null && smsBalance !== undefined && Number(smsBalance) < smsThreshold };

  // Pro plans ending in the next 30 days or ended in the last 60, soonest
  // first. Extending adds to the current end date (lib/pro-renewals.js).
  const REMINDER_LABELS = { '14d': '14 days before', '3d': '3 days before', lapsed: 'on lapsing' };
  const renewalRows = renewals.map((c) => [
    `<a class="platform-church-link" href="/platform/churches/${c.id}"><strong>${esc(c.name)}</strong><small>${esc(c.slug)}</small></a>`,
    `${esc(isoDate(c.proUntil))}<small>${c.lapsed ? `<span class="pill pill-failed">ended ${Math.abs(c.daysLeft)} day${Math.abs(c.daysLeft) === 1 ? '' : 's'} ago</span>` : `<span class="pill pill-${c.daysLeft <= 3 ? 'failed' : 'pending'}">${c.daysLeft} day${c.daysLeft === 1 ? '' : 's'} left</span>`}</small>`,
    esc(c.lastReminder ? `Sent ${REMINDER_LABELS[c.lastReminder]}` : 'None yet'),
    `<form method="post" action="/platform/churches/${c.id}/extend" class="inline platform-inline-form">
      <select name="months" aria-label="Extend by">${[1, 3, 6, 12].map((m) => `<option value="${m}"${m === 12 ? ' selected' : ''}>${m} month${m === 1 ? '' : 's'}</option>`).join('')}</select>
      <button type="submit">Extend</button>
    </form>`,
  ]);

  // SMS sender names churches have asked for (Communications › SMS
  // delivery). Register each with the SMS provider first; approve it here
  // only once the provider has, or texts are accepted and never arrive.
  const senderRows = senderRequests.map((c) => [
    `<a class="platform-church-link" href="/platform/churches/${c.id}"><strong>${esc(c.name)}</strong><small>${esc(c.slug)}</small></a>`,
    `<strong>${esc(c.smsSenderId)}</strong>`,
    `<div class="platform-actions">
      <form method="post" action="/platform/churches/${c.id}/sms-sender" class="inline platform-inline-form">
        <input type="hidden" name="action" value="approve"><input type="hidden" name="senderId" value="${esc(c.smsSenderId)}">
        <button type="submit">Approve</button>
      </form>
      <form method="post" action="/platform/churches/${c.id}/sms-sender" class="inline platform-inline-form">
        <input type="hidden" name="action" value="reject"><input type="hidden" name="senderId" value="${esc(c.smsSenderId)}">
        <input name="note" maxlength="200" placeholder="Reason (shown to the church)">
        <button type="submit" class="danger">Reject</button>
      </form>
    </div>`,
  ]);

  const rows = churches.map((c) => [
    `<a class="platform-church-link" href="/platform/churches/${c.id}"><strong>${esc(c.name)}</strong><small>${esc(c.slug)}</small></a>`,
    `${planPill(c)}${c.proUntil ? `<small>Until ${isoDate(c.proUntil)}</small>` : ''}`,
    `${accessPill(c)}${c.suspensionReason ? `<small>${esc(c.suspensionReason)}</small>` : ''}${c.deletionReason ? `<small>${esc(c.deletionReason)}</small>` : ''}`,
    `<span class="platform-usage"><strong>${c._count.users}</strong> users</span><span class="platform-usage"><strong>${c._count.members}</strong> members</span>`,
    `<span class="platform-usage"><strong>${c._count.events}</strong> events</span><span class="platform-usage"><strong>${c._count.broadcasts}</strong> broadcasts</span>`,
    esc(isoDate(c.createdAt)),
    `<div class="platform-actions"><a class="btn ghost" href="/platform/churches/${c.id}">Manage</a></div>`,
  ]);

  const auditRows = recentAudit.map((a) => [
    esc(dateTime(a.occurredAt)),
    esc(a.operatorEmail || '—'),
    a.churchId ? `<a href="/platform/churches/${esc(a.churchId)}">${esc(a.event)}</a>` : esc(a.event),
    esc(a.subject || '—'),
  ]);

  const errorRows = recentErrors.map((e) => [
    esc(dateTime(e.occurredAt)),
    e.church ? `<a href="/platform/churches/${e.churchId}">${esc(e.church.name)}</a><small>${esc(e.church.slug)}</small>` : 'Platform',
    esc(e.path || '—'),
    esc(e.message || '—'),
  ]);

  const body = `
    ${pageHero('SaaS Owner Portal', 'Manage every church, plan, access state, user footprint and operational signal across the platform.')}
    ${ownerSummaryCards(stats, sms, atRisk)}
    ${growth.length ? growthCard(growth) : ''}
    ${renewalRows.length ? listCard({
      title: 'Pro renewals', count: renewalRows.length, countLabel: renewalRows.length === 1 ? 'church' : 'churches',
      note: 'Ending in the next 30 days or ended in the last 60. Admins are reminded 14 and 3 days before, and when it ends.',
      inner: table(['Church', 'Pro until', 'Reminders', ''], renewalRows, { keyCols: 2 }),
    }) : ''}
    ${senderRows.length ? listCard({
      title: 'SMS sender names to approve', count: senderRows.length, countLabel: senderRows.length === 1 ? 'request' : 'requests',
      note: 'Register each name with the SMS provider first, and approve it here once the provider has.',
      inner: table(['Church', 'Sender name', ''], senderRows, { keyCols: 2 }),
    }) : ''}
    ${portalFilters(req.query || {})}
    ${listCard({
      title: 'Churches onboarded', count: churches.length, countLabel: churches.length === 1 ? 'church' : 'churches',
      note: churches.length >= 250 ? 'Showing latest 250 matches' : '',
      inner: churches.length ? table(['Church', 'Plan', 'Access', 'People', 'Activity', 'Signed up', ''], rows, { keyCols: 3 }) : '<div class="empty-state"><div class="empty-ico">▣</div><h3>No churches match these filters</h3><p>Try clearing search or status filters.</p></div>',
    })}
    <div class="platform-two-col">
      ${listCard({
        title: 'Operator activity', count: recentAudit.length, countLabel: 'events',
        inner: auditRows.length ? table(['When', 'Operator', 'Event', 'Subject'], auditRows, { keyCols: 2 }) : '<p class="muted-text">No audit events yet.</p>',
      })}
      ${listCard({
        title: 'Recent errors', count: recentErrors.length, countLabel: 'errors',
        inner: errorRows.length ? table(['When', 'Church', 'Path', 'Message'], errorRows, { keyCols: 2 }) : '<p class="muted-text">No recent errors.</p>',
      })}
    </div>`;
  page(res, { title: 'SaaS Owner Portal', active: '/platform', noHeader: true, body });
}

// Support tools for one user (routes-pg-html/platform-support.js).
function supportMenu(churchId, u) {
  const base = `/platform/churches/${encodeURIComponent(churchId)}/users/${u.id}`;
  const locked = u.lockedUntil && new Date(u.lockedUntil) > new Date();
  const btn = (action, label, extra = '', cls = 'ghost') => `<form method="post" action="${base}/${action}" class="inline platform-inline-form">${extra}<button type="submit" class="${cls}">${label}</button></form>`;
  return `<details class="op-help"><summary>Help${locked ? ' <span class="pill pill-failed">locked</span>' : ''}</summary>
    <div class="op-help-body">
      <p><b>Password reset link</b></p>
      ${u.email ? btn('reset', 'Email it', '<input type="hidden" name="via" value="email">') : ''}
      ${u.phone ? btn('reset', 'Text it', '<input type="hidden" name="via" value="sms">') : ''}
      ${btn('reset', 'Show it to me', '<input type="hidden" name="via" value="show">')}
      ${locked || u.failedAttempts ? `<p><b>Wrong passwords</b> (${u.failedAttempts || 0})</p>${btn('unlock', 'Unlock')}` : ''}
      ${u.email && !u.emailVerifiedAt ? `<p><b>Email not verified</b></p>${btn('verify', 'Resend verification')}` : ''}
      <p><b>Change how they sign in</b></p>
      <form method="post" action="${base}/sign-in" class="filter-bar">
        <input type="email" name="email" value="${esc(u.email || '')}" placeholder="Email" aria-label="Email">
        <input name="phone" value="${esc(u.phone || '')}" placeholder="Phone" aria-label="Phone">
        <button type="submit">Save</button>
      </form>
    </div>
  </details>`;
}

async function renderChurchDetail(req, res) {
  const id = req.params.id;
  const church = await rawDb.church.findUnique({
    where: { id },
    include: { _count: { select: {
      users: true, members: true, events: true, attendance: true, broadcasts: true,
      incomeRecords: true, expenses: true, funds: true, journalEntries: true,
      securityAuditLogs: true, errorLogs: true,
    } } },
  });
  if (!church) return res.status(404).send('Church not found');

  const [users, recentAudit, recentActivity, recentBroadcasts, recentErrors, lastEmail, payments] = await Promise.all([
    rawDb.user.findMany({
      where: { churchId: id, deletedAt: null },
      orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
      take: 50,
      select: { id: true, username: true, email: true, phone: true, displayName: true, role: true, financeRole: true, createdAt: true, totpEnabled: true, lastLoginAt: true, emailVerifiedAt: true, failedAttempts: true, lockedUntil: true },
    }),
    rawDb.securityAuditLog.findMany({ where: { churchId: id }, orderBy: { occurredAt: 'desc' }, take: 12 }),
    rawDb.activityLog.findMany({ where: { churchId: id }, orderBy: { occurredAt: 'desc' }, take: 10 }),
    rawDb.broadcast.findMany({ where: { churchId: id }, orderBy: { sentAt: 'desc' }, take: 8 }),
    rawDb.errorLog.findMany({ where: { churchId: id }, orderBy: { occurredAt: 'desc' }, take: 8 }).catch(() => []),
    rawDb.emailLog.findFirst({ where: { churchId: id }, orderBy: { occurredAt: 'desc' } }).catch(() => null),
    rawDb.platformPayment.findMany({ where: { payerChurchId: id }, orderBy: { paidOn: 'desc' }, take: 20 }),
  ]);

  const userRows = users.map((u) => [
    `<strong>${esc(u.displayName || u.username)}</strong><small>${esc(u.username)}</small>`,
    [u.email, u.phone].filter(Boolean).map(esc).join('<br>') || '—',
    `<span class="pill">${esc(u.role)}</span>`,
    esc(u.financeRole),
    u.totpEnabled ? '<span class="pill pill-fulfilled">2FA</span>' : '<span class="muted-text">—</span>',
    esc(isoDate(u.createdAt)),
    u.lastLoginAt ? esc(dateTime(u.lastLoginAt)) : '<span class="muted-text">—</span>',
    supportMenu(id, u),
  ]);

  const auditRows = recentAudit.map((a) => [
    esc(dateTime(a.occurredAt)), esc(a.event), esc(a.subject || '—'), esc(a.ip || '—'),
  ]);
  const activityRows = recentActivity.map((a) => [
    esc(dateTime(a.occurredAt)), esc(a.kind), esc(a.description),
  ]);
  const broadcastRows = recentBroadcasts.map((b) => [
    esc(dateTime(b.sentAt)), esc(b.channel), esc(b.audienceLabel),
    `<span class="pill">${esc(b.status)}</span>`,
    `${b.successfulSends}/${b.totalRecipients}`,
  ]);
  const errorRows = recentErrors.map((e) => [
    esc(dateTime(e.occurredAt)), esc(e.method || '—'), esc(e.path || '—'), esc(e.message || '—'),
  ]);

  const accessNote = church.deletedAt
    ? `<p class="error">Deleted: ${esc(church.deletionReason || 'No reason recorded')}. Purge eligible ${isoDate(church.deletionPurgeAfter)}.</p>`
    : church.suspendedAt
      ? `<p class="error">Suspended: ${esc(church.suspensionReason || 'No reason recorded')}.</p>`
      : '<p class="success">This church currently has active access.</p>';

  const body = `
    <div class="platform-detail-top">
      <a class="btn ghost" href="/platform">← All churches</a>
    </div>
    ${pageHero(church.name, `${church.slug} · Signed up ${isoDate(church.createdAt)}`)}
    <div class="platform-detail-grid">
      <div class="card platform-status-card">
        <div class="card-head"><h2>Account state</h2><span class="meta">${accessPill(church)} ${planPill(church)}</span></div>
        ${accessNote}
        <dl class="platform-dl">
          <dt>Plan</dt><dd>${esc(church.plan)}${church.proUntil ? ` until ${isoDate(church.proUntil)}` : ''}</dd>
          <dt>Created</dt><dd>${esc(dateTime(church.createdAt))}</dd>
          <dt>Updated</dt><dd>${esc(dateTime(church.updatedAt))}</dd>
          <dt>Last email</dt><dd>${lastEmail ? `${esc(lastEmail.status)} · ${esc(dateTime(lastEmail.occurredAt))}` : '—'}</dd>
        </dl>
      </div>
      <div class="card platform-control-card">
        <div class="card-head"><h2>Owner controls</h2><span class="meta">Plan and access</span></div>
        <div class="platform-control-stack">${quickControls(church, true)}</div>
      </div>
    </div>
    ${statsRow([
      { cls: 'gold', icon: icon('users'), value: church._count.users.toLocaleString(), label: 'Users' },
      { cls: 'green', icon: icon('members'), value: church._count.members.toLocaleString(), label: 'Members' },
      { cls: 'blue', icon: icon('events'), value: church._count.events.toLocaleString(), label: 'Events' },
      { cls: 'purple', icon: icon('communications'), value: church._count.broadcasts.toLocaleString(), label: 'Broadcasts' },
      { cls: 'orange', icon: icon('finance'), value: church._count.journalEntries.toLocaleString(), label: 'Journal entries' },
    ])}
    <div class="platform-mini-grid">
      <div><strong>${church._count.attendance.toLocaleString()}</strong><span>Attendance rows</span></div>
      <div><strong>${church._count.incomeRecords.toLocaleString()}</strong><span>Income records</span></div>
      <div><strong>${church._count.expenses.toLocaleString()}</strong><span>Expenses</span></div>
      <div><strong>${church._count.funds.toLocaleString()}</strong><span>Funds</span></div>
      <div><strong>${church._count.securityAuditLogs.toLocaleString()}</strong><span>Audit events</span></div>
      <div><strong>${church._count.errorLogs.toLocaleString()}</strong><span>Error logs</span></div>
    </div>
    ${listCard({
      title: 'Payments', count: payments.length, countLabel: payments.length === 1 ? 'payment' : 'payments',
      note: payments.length ? `GH₵ ${payments.reduce((n, p) => n + Number(p.amount), 0).toLocaleString('en-GH', { minimumFractionDigits: 2 })} in total` : '',
      inner: `${payments.length ? table(['Paid on', 'Amount', 'Method', 'Reference', 'Covers'], payments.map((p) => [esc(isoDate(p.paidOn)), `<strong>GH₵ ${esc(Number(p.amount).toLocaleString('en-GH', { minimumFractionDigits: 2 }))}</strong>`, esc(p.method), esc(p.reference || '—'), esc(p.months ? `${p.months} mo` : '—')]), { keyCols: 2 }) : '<p class="muted-text">No payments recorded.</p>'}
        <p><a class="btn ghost" href="/platform/payments?church=${encodeURIComponent(id)}#record">Record a payment</a></p>`,
    })}
    <section class="card" id="support-view">
      <div class="card-head"><h2>View as church</h2><span class="meta">${accessOpen(church) ? `<span class="pill pill-sent">allowed until ${esc(dateTime(church.supportAccessUntil))}</span>` : '<span class="pill">not allowed</span>'}</span></div>
      ${accessOpen(church)
        ? `<p>See this church's app as one of its admins would, read-only, to look into a problem. Nothing can be changed or exported, and the church's security log records the visit.</p>
           <form method="post" action="/platform/churches/${esc(id)}/view" class="inline platform-inline-form"><button type="submit">View as church (read-only)</button></form>`
        : '<p class="muted-text">The church must allow it first: one of its admins turns on <strong>Settings › Support access</strong>, for 1 hour, 24 hours or 3 days.</p>'}
    </section>
    <div id="users"></div>
    ${listCard({
      title: 'Users and roles', count: users.length, countLabel: 'users',
      inner: userRows.length ? table(['Name', 'Signs in with', 'Role', 'Finance', 'Security', 'Created', 'Last sign-in', ''], userRows, { keyCols: 2 }) : '<p class="muted-text">No active users.</p>',
    })}
    <div class="platform-two-col">
      ${listCard({
        title: 'Recent audit', count: recentAudit.length, countLabel: 'events',
        inner: auditRows.length ? table(['When', 'Event', 'Subject', 'IP'], auditRows, { keyCols: 2 }) : '<p class="muted-text">No audit events.</p>',
      })}
      ${listCard({
        title: 'Recent activity', count: recentActivity.length, countLabel: 'events',
        inner: activityRows.length ? table(['When', 'Kind', 'Description'], activityRows, { keyCols: 2 }) : '<p class="muted-text">No activity yet.</p>',
      })}
    </div>
    <div class="platform-two-col">
      ${listCard({
        title: 'Broadcasts', count: recentBroadcasts.length, countLabel: 'broadcasts',
        inner: broadcastRows.length ? table(['When', 'Channel', 'Audience', 'Status', 'Sent'], broadcastRows, { keyCols: 2 }) : '<p class="muted-text">No broadcasts yet.</p>',
      })}
      ${listCard({
        title: 'Errors', count: recentErrors.length, countLabel: 'errors',
        inner: errorRows.length ? table(['When', 'Method', 'Path', 'Message'], errorRows, { keyCols: 2 }) : '<p class="muted-text">No errors logged.</p>',
      })}
    </div>`;
  return page(res, { title: `${church.name} · Platform`, active: '/platform', noHeader: true, body });
}

function register(app) {
  app.get('/platform', requireOperator, asyncHandler(renderPlatformIndex));
  app.get('/platform/churches/:id', requireOperator, asyncHandler(renderChurchDetail));

  app.post('/platform/churches/:id/plan', requireOperator, asyncHandler(async (req, res) => {
    const { plan, months } = req.body || {};
    if (!['free', 'pro'].includes(plan)) { flash(req, 'Plan must be "free" or "pro".'); return res.redirect(platformReturn(req)); }
    const data = { plan };
    if (plan === 'pro') {
      data.proSince = new Date();
      data.proUntil = months ? new Date(Date.now() + Number(months) * 30 * 24 * 60 * 60 * 1000) : null;
    } else {
      data.proSince = null;
      data.proUntil = null;
    }
    try {
      const church = await rawDb.church.update({ where: { id: req.params.id }, data });
      const event = plan === 'pro' ? 'platform.plan_upgraded' : 'platform.plan_downgraded';
      const subject = `${church.name} (${church.slug}) -> ${plan}`;
      await rawDb.securityAuditLog.create({ data: {
        churchId: church.id, actorId: null, event, subject,
        ip: requestIp(req), userAgent: requestUserAgent(req),
      } });
      await logPlatformEvent(req, { operator: res.locals.operator, event, subject, churchId: church.id });
      flash(req, plan === 'pro' ? 'Church upgraded to Pro.' : 'Church downgraded to Free.', 'success');
    } catch (e) {
      if (e.code !== 'P2025') throw e;
      flash(req, 'Church not found.');
    }
    res.redirect(platformReturn(req));
  }));

  // Approve or reject a church's SMS sender name. The name is posted back
  // and must still match, so a request changed since the page loaded is not
  // approved by mistake.
  // Extend a Pro plan by whole months from its current end (or from today
  // if it has lapsed). Use Plan above to set a date from scratch.
  app.post('/platform/churches/:id/extend', requireOperator, asyncHandler(async (req, res) => {
    const months = Number(req.body?.months);
    if (![1, 3, 6, 12].includes(months)) { flash(req, 'Choose 1, 3, 6 or 12 months.'); return res.redirect(platformReturn(req)); }
    const church = await rawDb.church.findUnique({ where: { id: req.params.id }, select: { id: true, name: true, slug: true, plan: true, proUntil: true, proSince: true } });
    if (!church) { flash(req, 'Church not found.'); return res.redirect(platformReturn(req)); }
    const proUntil = extendedUntil(church.plan === 'pro' ? church.proUntil : null, months);
    await rawDb.church.update({ where: { id: church.id }, data: { plan: 'pro', proUntil, proSince: church.plan === 'pro' && church.proSince ? church.proSince : new Date() } });
    const subject = `${church.name} (${church.slug}) Pro extended ${months} month${months === 1 ? '' : 's'}, until ${isoDate(proUntil)}`;
    await rawDb.securityAuditLog.create({ data: {
      churchId: church.id, actorId: null, event: 'platform.plan_extended', subject,
      ip: requestIp(req), userAgent: requestUserAgent(req),
    } });
    await logPlatformEvent(req, { operator: res.locals.operator, event: 'platform.plan_extended', subject, churchId: church.id });
    flash(req, `${church.name}: Pro until ${isoDate(proUntil)}.`, 'success');
    res.redirect(platformReturn(req));
  }));

  app.post('/platform/churches/:id/sms-sender', requireOperator, asyncHandler(async (req, res) => {
    const action = String(req.body?.action || '');
    const note = String(req.body?.note || '').trim().slice(0, 200);
    if (!['approve', 'reject'].includes(action)) { flash(req, 'Invalid sender name action.'); return res.redirect(platformReturn(req)); }
    const church = await rawDb.church.findUnique({ where: { id: req.params.id }, select: { id: true, name: true, slug: true, smsSenderId: true, smsSenderStatus: true } });
    if (!church || church.smsSenderStatus !== 'PENDING' || church.smsSenderId !== String(req.body?.senderId || '')) {
      flash(req, 'That request has changed or is no longer waiting. Check the list again.');
      return res.redirect(platformReturn(req));
    }
    await rawDb.church.update({
      where: { id: church.id },
      data: action === 'approve' ? { smsSenderStatus: 'APPROVED', smsSenderNote: null } : { smsSenderStatus: 'REJECTED', smsSenderNote: note || null },
    });
    const event = action === 'approve' ? 'platform.sms_sender_approved' : 'platform.sms_sender_rejected';
    const subject = `${church.name} (${church.slug}): ${church.smsSenderId}${note && action === 'reject' ? ` (${note})` : ''}`;
    await rawDb.securityAuditLog.create({ data: {
      churchId: church.id, actorId: null, event, subject,
      ip: requestIp(req), userAgent: requestUserAgent(req),
    } });
    await logPlatformEvent(req, { operator: res.locals.operator, event, subject, churchId: church.id });
    flash(req, action === 'approve' ? `"${church.smsSenderId}" approved for ${church.name}. Their texts now use it.` : `"${church.smsSenderId}" rejected for ${church.name}.`, 'success');
    res.redirect(platformReturn(req));
  }));

  app.post('/platform/churches/:id/access', requireOperator, asyncHandler(async (req, res) => {
    const action = String(req.body?.action || '');
    const reason = String(req.body?.reason || '').trim().slice(0, 500);
    if (!['suspend', 'reactivate', 'delete', 'restore'].includes(action)) {
      flash(req, 'Invalid access action.');
      return res.redirect(platformReturn(req));
    }
    if (['suspend', 'delete'].includes(action) && !reason) {
      flash(req, 'A reason is required.');
      return res.redirect(platformReturn(req));
    }
    try {
      const existing = await rawDb.church.findUnique({ where: { id: req.params.id } });
      if (!existing) {
        flash(req, 'Church not found.');
        return res.redirect(platformReturn(req));
      }
      if (action === 'delete' && String(req.body?.confirmSlug || '') !== existing.slug) {
        flash(req, `Type ${existing.slug} exactly to confirm deletion.`);
        return res.redirect(platformReturn(req));
      }
      const data = action === 'suspend'
        ? { suspendedAt: new Date(), suspensionReason: reason }
        : action === 'reactivate'
          ? { suspendedAt: null, suspensionReason: null }
          : action === 'delete'
            ? {
              deletedAt: new Date(), deletionReason: reason,
              deletionPurgeAfter: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
            }
            : { deletedAt: null, deletionReason: null, deletionPurgeAfter: null };
      const church = await rawDb.church.update({ where: { id: req.params.id }, data });
      // Deleting frees the church's login emails for reuse; restoring takes them back.
      const released = action === 'delete' ? await releaseChurchEmails(rawDb, church.id) : 0;
      const reclaimed = action === 'restore' ? await reclaimChurchEmails(rawDb, church.id) : null;
      const events = {
        suspend: 'platform.church_suspended', reactivate: 'platform.church_reactivated',
        delete: 'platform.church_deleted', restore: 'platform.church_restored',
      };
      const subject = ['suspend', 'delete'].includes(action) ? reason : `${church.name} ${action}d`;
      await rawDb.securityAuditLog.create({ data: {
        churchId: church.id, actorId: null, event: events[action], subject,
        ip: requestIp(req), userAgent: requestUserAgent(req),
      } });
      await logPlatformEvent(req, { operator: res.locals.operator, event: events[action], subject: `${church.name} (${church.slug}): ${subject}`, churchId: church.id });
      const messages = {
        suspend: 'Church access suspended.', reactivate: 'Church access reactivated.',
        delete: `Church deleted. Its data remains recoverable for 30 days, and its login emails and phone numbers (${released}) are free to use again.`,
        restore: reclaimed && reclaimed.taken.length
          ? `Church restored. These logins are now used by other accounts, so those users need a new email or phone before they can sign in: ${reclaimed.taken.join(', ')}.`
          : 'Church restored, with its logins.',
      };
      flash(req, messages[action], reclaimed && reclaimed.taken.length ? 'error' : 'success');
    } catch (e) {
      if (e.code !== 'P2025') throw e;
      flash(req, 'Church not found.');
    }
    return res.redirect(platformReturn(req));
  }));
}

module.exports = { register };
