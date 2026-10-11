'use strict';
// Phase 8f: the authenticated dashboard (GET / when logged in).
//
// NOT a full port of the original's dashboard — that one is an elaborate
// mockup-style page (sparklines, donut charts, month-over-month giving
// series broken down by harvest/special-offering/service type, Akan
// day-born distribution) built on finance sub-features (harvests, special
// offerings, service-level offerings) that were never ported to this stack
// (see the Phase 8e "Finance scope" decision — deferred, needs new backend
// work, not just HTML). This dashboard aggregates only what the ALREADY-
// PORTED modules track: members, attendance/events, generic income, and
// recent activity — bounded the same way every other Phase 8 module is.

const { esc, fmtMoney } = require('./format');
const { statsRow } = require('./views');

// Individual giving/expense entries (fund names, donor names, amounts) are
// only for roles with finance access — the same check routes-pg-html/
// finance.js's requireFinanceReportAccess uses. Mirrors every "kind" logged
// via logActivity() in finance.js's routes.
const FINANCE_ACTIVITY_KINDS = new Set([
  'contribution_recorded', 'expense_recorded', 'expense_submitted', 'expense_approved',
  'expense_rejected', 'finance_reversal', 'fund_created', 'income_recorded',
  'period_locked', 'period_reopened', 'pledge_edited', 'pledge_payment', 'project_created',
  'project_edited', 'receipt_sent', 'statement_sent',
]);

function canSeeFinance(user) {
  return Boolean(user && (user.role === 'ADMIN' || (user.financeRole && user.financeRole !== 'NONE')));
}

const MEMBERSHIP_STATUS_LABELS = {
  MEMBER: 'Member', REGULAR: 'Regular', VISITOR: 'Visitor',
  INACTIVE: 'Inactive', TRANSFERRED: 'Transferred', DECEASED: 'Deceased',
};

// Same bar-list visual as the finance report suite's financeBars() (reuses
// the .finance-report-bar CSS), but for plain counts — no money involved,
// so it is safe to show to every role, unlike the finance reports.
function countBars(rows) {
  if (!rows.length) return '<p class="muted-text">No data yet.</p>';
  const max = Math.max(...rows.map((r) => r.count), 1);
  const total = rows.reduce((s, r) => s + r.count, 0);
  return `<div class="finance-report-bars">${rows.map((r) => `<div class="finance-report-bar">
    <span>${esc(r.label)}</span><div><i style="width:${Math.max(2, r.count / max * 100)}%"></i></div>
    <strong>${r.count}</strong><small>${total ? Math.round(r.count / total * 100) : 0}%</small>
  </div>`).join('')}</div>`;
}

// Monday-start week buckets for the last N weeks (including the current,
// in-progress one), oldest first — matches how the finance reports frame
// "this period vs prior period" comparisons.
function lastWeeks(n, now) {
  const day = now.getDay();
  const mondayThisWeek = new Date(now);
  mondayThisWeek.setHours(0, 0, 0, 0);
  mondayThisWeek.setDate(now.getDate() - ((day + 6) % 7));
  const weeks = [];
  for (let i = n - 1; i >= 0; i--) {
    const start = new Date(mondayThisWeek); start.setDate(mondayThisWeek.getDate() - i * 7);
    const end = new Date(start); end.setDate(start.getDate() + 7);
    weeks.push({ start, end });
  }
  return weeks;
}

// Roles that can act on approval queues (same check as the finance routes'
// requireFundManager).
function isFundManager(user) {
  return Boolean(user && (user.role === 'ADMIN' || ['FINANCE_ADMIN', 'TREASURER'].includes(user.financeRole)));
}

function firstName(user) {
  const name = String((user && (user.displayName || user.username)) || '').trim();
  return name.split(/\s+/)[0] || '';
}

// Six short vertical bars for the attendance trend. Plain HTML/CSS, no chart
// library: height is the share of the busiest week.
function miniBars(rows) {
  const max = Math.max(...rows.map((r) => r.count), 1);
  return `<div class="mini-bars" role="img" aria-label="Attendance for the last ${rows.length} weeks">${rows.map((r) => `
    <div class="mb"><b>${r.count}</b><i style="height:${Math.max(3, Math.round(r.count / max * 100))}%"></i><span>${esc(r.short)}</span></div>`).join('')}</div>`;
}

async function renderDashboard(db, user) {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const weekAgo = new Date(Date.now() - 7 * 86400000);
  const canMoney = canSeeFinance(user);
  const manager = isFundManager(user);

  const weeks = lastWeeks(6, now);

  const [
    totalMembers, newMembersThisMonth, upcomingEvents, recentAttendance,
    incomeThisMonth, recentActivityRows,
    membershipByStatus, weeklyAttendanceCounts,
    expensesWaiting, countsWaiting, depositsWaiting, membersNoContact,
  ] = await Promise.all([
    db.member.count({ where: { deletedAt: null, membershipStatus: { in: ['MEMBER', 'REGULAR', 'VISITOR'] } } }),
    db.member.count({ where: { deletedAt: null, joinDate: { gte: monthStart } } }),
    db.event.findMany({ where: { startsAt: { gte: now } }, orderBy: { startsAt: 'asc' }, take: 5 }),
    db.attendance.count({ where: { checkedInAt: { gte: weekAgo } } }),
    canMoney ? db.incomeRecord.aggregate({ where: { deletedAt: null, transactionDate: { gte: monthStart } }, _sum: { amount: true } }) : Promise.resolve(null),
    // Fetch extra rows when finance kinds must be filtered out, so the visible
    // list still fills up to 8 entries rather than being thinned by the filter.
    db.activityLog.findMany({ orderBy: { occurredAt: 'desc' }, take: canMoney ? 8 : 30 }),
    db.member.groupBy({ by: ['membershipStatus'], where: { deletedAt: null }, _count: true }),
    Promise.all(weeks.map((w) => db.attendance.count({ where: { checkedInAt: { gte: w.start, lt: w.end } } }))),
    // The "needs your attention" queues are only counted for people who can act on them.
    manager ? db.expense.count({ where: { approvalStatus: 'SUBMITTED' } }) : Promise.resolve(0),
    manager ? db.cashCountSheet.count({ where: { status: 'COUNTED' } }) : Promise.resolve(0),
    manager ? db.bankDeposit.count({ where: { status: 'DEPOSITED' } }) : Promise.resolve(0),
    user && user.role === 'ADMIN' ? db.member.count({ where: { deletedAt: null, email: null, mobilePhone: null } }) : Promise.resolve(0),
  ]);
  const recentActivity = (canMoney ? recentActivityRows : recentActivityRows.filter((a) => !FINANCE_ACTIVITY_KINDS.has(a.kind))).slice(0, 8);

  const membershipBars = membershipByStatus
    .map((r) => ({ label: MEMBERSHIP_STATUS_LABELS[r.membershipStatus] || r.membershipStatus, count: r._count }))
    .sort((a, b) => b.count - a.count);
  const attendanceRows = weeks.map((w, i) => ({
    short: i === weeks.length - 1 ? 'Now' : w.start.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }),
    count: weeklyAttendanceCounts[i],
  }));

  const hour = now.getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const name = firstName(user);
  const isAdmin = user && user.role === 'ADMIN';
  const header = `<header class="dash-head">
    <div>
      <p class="dash-date">${now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}</p>
      <h1>${greeting}${name ? `, ${esc(name)}` : ''}.</h1>
    </div>
    <div class="dash-actions">
      <a class="btn ghost" href="/events">Calendar</a>
      ${isAdmin ? '<a class="btn" href="/members/new">Add member</a>' : ''}
    </div>
  </header>`;

  const stats = statsRow([
    { cls: 'gold', icon: '', value: totalMembers.toLocaleString(), label: 'Members' },
    { cls: 'green', icon: '', value: newMembersThisMonth.toLocaleString(), label: 'New this month' },
    { cls: 'blue', icon: '', value: recentAttendance.toLocaleString(), label: 'Check-ins, 7 days' },
    canMoney
      ? { cls: 'purple', icon: '', value: fmtMoney(incomeThisMonth._sum.amount || 0), label: 'Income this month' }
      : { cls: 'purple', icon: '', value: '—', label: 'Finance restricted' },
  ]);

  // What is waiting on this person. Nothing waiting is itself useful to say.
  const waiting = [];
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  if (expensesWaiting) waiting.push({ href: '/finance/expenses', text: `${plural(expensesWaiting, 'expense', 'expenses')} waiting for approval` });
  if (countsWaiting) waiting.push({ href: '/finance/cash-counts', text: `${plural(countsWaiting, 'cash count', 'cash counts')} to verify` });
  if (depositsWaiting) waiting.push({ href: '/finance/deposits', text: `${plural(depositsWaiting, 'bank deposit', 'bank deposits')} to verify` });
  if (membersNoContact) waiting.push({ href: '/members', text: `${plural(membersNoContact, 'member has', 'members have')} no phone or email on file` });
  const attention = (manager || isAdmin) ? `
    <section class="dash-block">
      <h2>Needs your attention</h2>
      ${waiting.length
        ? `<ul class="todo">${waiting.map((w) => `<li><a href="${w.href}"><span>${esc(w.text)}</span><i aria-hidden="true">→</i></a></li>`).join('')}</ul>`
        : '<p class="all-clear">Nothing is waiting on you. Approvals, counts and deposits are all up to date.</p>'}
    </section>` : '';

  const eventDate = (d) => `<span class="when-date"><b>${d.getDate()}</b><small>${d.toLocaleDateString('en-GB', { month: 'short' })}</small></span>`;
  const upcoming = `
    <section class="dash-block">
      <div class="dash-block-head"><h2>Upcoming events</h2><a href="/events">All events →</a></div>
      ${upcomingEvents.length
        ? `<ul class="events-list">${upcomingEvents.map((e) => `<li>${eventDate(e.startsAt)}
            <div><a href="/events/${e.id}">${esc(e.title)}</a>
            <small>${esc(e.startsAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }))}${e.location ? ` · ${esc(e.location)}` : ''}</small></div>
            <span class="pill pill-other">${esc(String(e.eventType).replace(/_/g, ' ').toLowerCase())}</span></li>`).join('')}</ul>`
        : '<p class="all-clear">Your calendar is clear. <a href="/events/new">Schedule an event</a></p>'}
    </section>`;

  const activity = `
    <section class="dash-block">
      <h2>Recent activity</h2>
      ${recentActivity.length
        ? `<ul class="activity">${recentActivity.map((a) => `<li><span>${a.link ? `<a href="${esc(a.link)}">${esc(a.description)}</a>` : esc(a.description)}</span><time>${esc(a.occurredAt.toISOString().slice(0, 10))}</time></li>`).join('')}</ul>`
        : '<p class="all-clear">Updates from your team will appear here.</p>'}
    </section>`;

  const trend = `
    <section class="dash-block">
      <div class="dash-block-head"><h2>Attendance</h2><span class="muted-text">last 6 weeks</span></div>
      ${miniBars(attendanceRows)}
    </section>`;
  const mix = `
    <section class="dash-block">
      <div class="dash-block-head"><h2>Membership</h2><a href="/reports">Reports →</a></div>
      ${countBars(membershipBars)}
    </section>`;

  return `<div class="dash">${header}${stats}
    <div class="dash-grid">
      <div class="dash-col">${attention}${upcoming}${activity}</div>
      <div class="dash-col">${trend}${mix}</div>
    </div></div>`;
}

module.exports = { renderDashboard };
