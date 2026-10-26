'use strict';
// The authenticated dashboard (GET / when logged in), Precision layout:
// greeting, an approvals callout, four key figures with sparklines, giving by
// type (12 weeks / 12 months), what needs this person's attention, birthdays
// this week, attendance, upcoming events with the membership mix, and recent
// activity.
//
// Money comes from the ledger (lib/ledger-pg.js incomeByDayAndAccount) — the
// same journal lines the Finance page sums — so the two never disagree. Every
// chart is server-rendered (HTML/SVG, no chart library); the only script is
// the 12 weeks / 12 months switch.

const { esc, initials, dobHasYear, fmtDMY } = require('./format');
const { icon } = require('./icons');
const { scriptTag } = require('./style-tags');
const { hasFinanceAccess } = require('./access');
const ledger = require('./ledger-pg');
const { toDay, addDays, ymd, entryForDate } = require('./liturgical');
const { entryCard } = require('./almanac-ui');
const { planPreacherText } = require('./preachers');

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

// The dashboard's "Recent activity" is the life of the church: people, services, events, groups,
// preaching and announcements, and money for the roles that may see it. Housekeeping (settings,
// sender names, user accounts, the colour of the app, the preacher list, reminders' bookkeeping ...)
// stays in the logs but is not shown here, so what is listed always reads like something that happened
// in the church. A new kind of log entry is left out until it is added below.
const CHURCH_LIFE_PREFIXES = ['member_', 'attendance', 'event', 'bible_class', 'organization', 'announcement', 'inventory'];
const CHURCH_LIFE_KINDS = new Set(['members_imported', 'preaching_scheduled', 'preaching_updated', 'preaching_deleted', 'preaching_reminder']);
const MONEY_ACTIVITY_KINDS = new Set([
  ...FINANCE_ACTIVITY_KINDS, 'pledge_created', 'deposit_recorded', 'deposit_verified', 'deposit_voided',
  'cash_count_entered', 'cash_count_verified', 'cash_count_voided', 'journal_reversed',
]);
function showsInFeed(kind, canMoney) {
  const k = String(kind || '');
  if (MONEY_ACTIVITY_KINDS.has(k)) return canMoney;
  return CHURCH_LIFE_KINDS.has(k) || CHURCH_LIFE_PREFIXES.some((p) => k.startsWith(p));
}

const MEMBERSHIP_STATUS_LABELS = {
  MEMBER: 'Members', REGULAR: 'Regulars', VISITOR: 'Visitors',
  DISTANT: 'Distant', INACTIVE: 'Inactive', TRANSFERRED: 'Transferred', DECEASED: 'Deceased', OTHER: 'Other',
};
const ACTIVE_STATUSES = ['MEMBER', 'REGULAR', 'VISITOR'];

const EVENT_TYPE_LABELS = {
  SERVICE: 'Service', PRAYER: 'Prayer', BIBLE_STUDY: 'Bible study', OUTREACH: 'Outreach', YOUTH: 'Youth',
  WEDDING: 'Wedding', FUNERAL: 'Funeral', BAPTISM: 'Baptism', CONFIRMATION: 'Confirmation', OTHER: 'Event',
};

// The chart's series are the ledger's income groups (lib/ledger-pg.js), so the
// dashboard and the Finance page split income the same way.
const GIVING_SERIES = ledger.INCOME_GROUPS.map((g) => ({ cls: g.key, name: g.name }));
const seriesFor = (code) => ledger.incomeGroupIndex(code) + 1;

function canSeeFinance(user) {
  return Boolean(user && (user.role === 'ADMIN' || (user.financeRole && user.financeRole !== 'NONE')));
}
// Roles that can act on approval queues (same check as the finance routes'
// requireFundManager).
function isFundManager(user) {
  return Boolean(user && (user.role === 'ADMIN' || ['FINANCE_ADMIN', 'TREASURER'].includes(user.financeRole)));
}
// Roles that may record money (the shell's "New" menu uses the same list).
function canFinanceWrite(user) {
  return Boolean(user && (user.role === 'ADMIN' || ['FINANCE_ADMIN', 'TREASURER', 'CASHIER'].includes(user.financeRole)));
}

function firstName(user) {
  const name = String((user && (user.displayName || user.username)) || '').trim();
  return name.split(/\s+/)[0] || '';
}

// ---- dates ------------------------------------------------------------------

const DAY = 86400000;
const pad = (n) => String(n).padStart(2, '0');
const isoLocal = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// Monday-start week buckets for the last n weeks, the current (in-progress)
// one last — matches how the finance reports frame "this period".
function lastWeeks(n, now) {
  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  const weeks = [];
  for (let i = n - 1; i >= 0; i--) {
    const start = new Date(monday); start.setDate(monday.getDate() - i * 7);
    const end = new Date(start); end.setDate(start.getDate() + 7);
    const sunday = new Date(end); sunday.setDate(end.getDate() - 1);
    weeks.push({ start, end, from: isoLocal(start), to: isoLocal(end), label: i === 0 ? 'This week' : fmtDMY(sunday), tip: i === 0 ? 'This week, so far' : `Week ending Sun ${fmtDMY(sunday)}` });
  }
  return weeks;
}
function lastMonths(n, now) {
  const months = [];
  for (let i = n - 1; i >= 0; i--) {
    const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
    const long = start.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    months.push({ start, end, from: isoLocal(start), to: isoLocal(end), label: start.toLocaleDateString('en-GB', { month: 'short' }), tip: i === 0 ? `${long}, so far` : long });
  }
  return months;
}
const inRange = (day, b) => day >= b.from && day < b.to;

const timeAgo = (d, now) => {
  const days = Math.floor((now - d) / DAY);
  if (days < 1) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return fmtDMY(d);
};

// ---- numbers ----------------------------------------------------------------

const num = (n) => Math.round(Number(n) || 0).toLocaleString('en-GB');
const cedis = (n) => `GH₵ ${Math.round(Number(n) || 0).toLocaleString('en-GH')}`;
const cedis2 = (n) => `GH₵ ${(Number(n) || 0).toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const compact = (n) => (Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(Math.abs(n) >= 100000 ? 0 : 1).replace(/\.0$/, '')}k` : String(Math.round(n)));
const sum = (a) => a.reduce((x, y) => x + y, 0);
function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw || 1)), m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
}
// Percentage change, or null when there is nothing to compare against.
const pctChange = (cur, prev) => (prev > 0 ? (cur - prev) / prev * 100 : null);

// ---- charts (server-rendered) -----------------------------------------------

// Catmull-Rom through the points, as cubic beziers.
function smooth(pts) {
  if (pts.length < 2) return '';
  const f = (n) => Math.round(n * 10) / 10;
  let d = `M${f(pts[0][0])},${f(pts[0][1])}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${f(c1[0])},${f(c1[1])} ${f(c2[0])},${f(c2[1])} ${f(p2[0])},${f(p2[1])}`;
  }
  return d;
}

function sparkline(values) {
  if (values.length < 2 || values.every((v) => v === values[0])) return '';
  const W = 80, H = 30, min = Math.min(...values), span = (Math.max(...values) - min) || 1;
  const pts = values.map((v, i) => [2 + i * (W - 4) / (values.length - 1), 3 + (H - 6) * (1 - (v - min) / span)]);
  const line = smooth(pts);
  return `<svg class="pd-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><path class="sa" d="${line} L${W - 2},${H} L2,${H} Z"/><path class="sl" d="${line}"/></svg>`;
}

// Stacked bar chart in HTML, so it stretches to whatever height its card is
// given. Hovering (or focusing) a column shows its breakdown.
function barChart({ buckets, series, fmt, label }) {
  const totals = buckets.map((_, i) => sum(series.map((s) => s.values[i])));
  const top = (() => { const peak = Math.max(...totals, 0); const step = niceStep(peak / 4 || 1); return { step, max: Math.ceil(peak / step) * step || step }; })();
  const ticks = [];
  for (let v = 0; v <= top.max + 1e-9; v += top.step) ticks.push(v);
  const yAxis = ticks.map((v) => `<span style="bottom:${(v / top.max * 100).toFixed(2)}%"><i>${compact(v)}</i></span>`).join('');
  // A full date (26/10/2026) is wider than a column: label every third column, as the line chart does.
  const sparseLabels = buckets.some((b) => String(b.label).length > 6 && b.label !== 'This week');
  const cols = buckets.map((b, i) => {
    const segs = series.map((s) => (s.values[i] > 0 ? `<i class="${s.cls}" style="flex-grow:${s.values[i]}"></i>` : '')).join('');
    const rows = series.map((s) => `<span><i class="${s.cls}"></i>${esc(s.name)}<em>${fmt(s.values[i])}</em></span>`).join('');
    return `<div class="pd-bc-col" tabindex="0" aria-label="${esc(b.tip)}: ${esc(fmt(totals[i]))}">
      <div class="pd-bc-stack" style="height:${(totals[i] / top.max * 100).toFixed(2)}%;--i:${i}">${segs}</div>
      <span class="pd-tip" aria-hidden="true"><b>${esc(b.tip)}</b>${rows}${series.length > 1 ? `<span class="tot">Total<em>${fmt(totals[i])}</em></span>` : ''}</span>
      <span class="pd-bc-x">${sparseLabels && (buckets.length - 1 - i) % 3 !== 0 ? '' : esc(b.label)}</span></div>`;
  }).join('');
  return `<div class="pd-bc" role="group" aria-label="${esc(label)}"><div class="pd-bc-plot"><div class="pd-bc-y" aria-hidden="true">${yAxis}</div><div class="pd-bc-cols">${cols}</div></div></div>`;
}

// Smooth area line for weekly attendance; the y-axis starts near the lowest
// week so week-to-week change is visible.
function areaChart(values, buckets, label) {
  const W = 360, H = 160, L = 36, R = 8, T = 10, B = 24;
  const peak = Math.max(...values, 1), low = Math.min(...values);
  const step = niceStep((peak - low) / 3 || peak / 3 || 1);
  const bottom = Math.max(0, Math.floor(low / step) * step - step), top = Math.ceil(peak / step) * step || step;
  const x = (i) => L + i * (W - L - R) / (values.length - 1);
  const y = (v) => T + (H - T - B) * (1 - (v - bottom) / ((top - bottom) || 1));
  const pts = values.map((v, i) => [x(i), y(v)]);
  const line = smooth(pts);
  let grid = '';
  for (let v = bottom; v <= top + 1e-9; v += step) grid += `<line class="pd-grid-l" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="pd-ax" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${num(v)}</text>`;
  const xs = buckets.map((b, i) => ((values.length - 1 - i) % 3 === 0 ? `<text class="pd-ax" x="${x(i)}" y="${H - 6}" text-anchor="middle">${esc(b.label)}</text>` : '')).join('');
  const dots = pts.map((p, i) => `<circle class="pd-dot" cx="${p[0]}" cy="${p[1]}" r="${i === pts.length - 1 ? 3.5 : 2.5}"><title>${esc(buckets[i].tip)}: ${num(values[i])} check-ins</title></circle>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">${grid}${xs}<path class="pd-area" d="${line} L${x(values.length - 1)},${y(bottom)} L${x(0)},${y(bottom)} Z"/><path class="pd-line" d="${line}"/>${dots}</svg>`;
}

// ---- small renderers --------------------------------------------------------

function delta(pct, invert = false) {
  if (pct === null || !Number.isFinite(pct)) return '';
  const r = Math.round(pct * 10) / 10;
  const tone = r === 0 ? 'flat' : (invert ? r < 0 : r > 0) ? 'up' : 'down';
  return `<span class="pd-delta ${tone}">${r > 0 ? '↑' : r < 0 ? '↓' : ''} ${Math.abs(r).toFixed(1)}%</span>`;
}
function kpi({ href, label, value, foot, spark, ic }) {
  const inner = `${ic ? `<span class="pd-kpi-ic" aria-hidden="true">${icon(ic)}</span>` : ''}<div class="pd-kpi-l">${esc(label)}</div><div class="pd-kpi-v">${value}</div><div class="pd-kpi-f">${foot}</div>${spark || ''}`;
  return href ? `<a class="pd-kpi" href="${href}">${inner}</a>` : `<div class="pd-kpi">${inner}</div>`;
}
function avatar(m) {
  return m.photoFilename
    ? `<span class="pd-av"><img src="/photos/${esc(m.photoFilename)}" alt=""></span>`
    : `<span class="pd-av">${esc(initials(`${m.firstName} ${m.lastName}`))}</span>`;
}
function activityIcon(kind) {
  const k = String(kind || '');
  if (FINANCE_ACTIVITY_KINDS.has(k)) return ['wallet', 'ok'];
  if (k.startsWith('member')) return ['members', 'accent'];
  if (k.startsWith('attendance') || k.includes('checkin')) return ['attendance', 'info'];
  if (k.startsWith('event')) return ['events', 'warn'];
  if (k.startsWith('preaching')) return ['preaching', 'accent'];
  if (k.startsWith('announcement')) return ['communications', 'info'];
  return ['clock', 'muted'];
}

// The seven days from today, as MM-DD keys. In a non-leap year 29 February
// birthdays are celebrated on the 28th.
function birthdayWindow(now) {
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
    const key = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    days.push({ key, date: d });
    const leap = new Date(d.getFullYear(), 1, 29).getMonth() === 1;
    if (key === '02-28' && !leap) days.push({ key: '02-29', date: d });
  }
  return days;
}

// ---- the page -----------------------------------------------------------------

/**
 * "This Sunday" for everyone: the Almanac's service for the next Sunday (today, if it is one),
 * with who is preaching. Empty when neither the Almanac nor the preaching plan has anything.
 * A failure here must never stop the dashboard.
 */
async function thisSundayCard(db, now) {
  try {
    const today = toDay(now);
    const sunday = addDays(today, (7 - today.getUTCDay()) % 7);
    // One after the other: if the first throws, the second must not be left running unobserved.
    const entry = await entryForDate(db, sunday);
    const plans = await db.preachingPlan.findMany({
      where: { deletedAt: null, preachDate: sunday }, orderBy: { id: 'asc' },
      include: { preacher: { select: { code: true, name: true } }, member: { select: { firstName: true, lastName: true } } },
    });
    const preachers = plans.map(planPreacherText).filter(Boolean);
    if (!entry && !preachers.length) return '';
    const body = entry
      ? `<ul class="almanac-list">${entryCard(entry, { preachers, numericDate: true })}</ul>`
      : `<p><b>${esc(fmtDMY(sunday, { utc: true }))}</b></p><p class="preaching"><b>Preaching:</b> ${preachers.map(esc).join('; ')}</p>`;
    return `<section class="pd-card" id="this-sunday">
      <div class="pd-ch"><div><h2>This Sunday</h2><p class="sub">${esc(fmtDMY(sunday, { utc: true }))}</p></div><a href="/almanac">Almanac</a></div>
      <div class="pd-body">${body}</div>
    </section>`;
  } catch (_) { return ''; }
}

async function renderDashboard(db, user) {
  const now = new Date();
  const churchId = user.churchId;
  const canMoney = canSeeFinance(user);
  const manager = isFundManager(user);
  const isAdmin = user && user.role === 'ADMIN';
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  // The same point last month (e.g. 1-12 Sep when today is 12 Oct), clamped
  // so a 31st never spills into this month.
  const lastMonthSamePoint = new Date(Math.min(lastMonthStart.getTime() + (now - monthStart), monthStart.getTime()));
  const weeks = lastWeeks(12, now);
  // Attendance compares whole weeks: 12 completed ones plus this week so far.
  const attWeeks = lastWeeks(13, now);
  const months = lastMonths(12, now);
  const recentFrom = new Date(Math.min(weeks[0].start.getTime(), lastMonthStart.getTime()));
  const bdays = birthdayWindow(now);
  const sundayCard = await thisSundayCard(db, now);

  const [
    totalMembers, joinedThisMonth, recentMembers, upcomingEvents, last7Attendance, weeklyAttendance,
    activityRows, membershipByStatus, expensesWaiting, countsWaiting, depositsWaiting, membersNoContact,
    incomeRows, birthdayRows, eventsNext30,
  ] = await Promise.all([
    db.member.count({ where: { deletedAt: null, membershipStatus: { in: ACTIVE_STATUSES } } }),
    db.member.count({ where: { deletedAt: null, joinDate: { gte: monthStart } } }),
    // Everyone added to the roll recently: drives the members and visitors sparklines and counts.
    db.member.findMany({ where: { deletedAt: null, createdAt: { gte: recentFrom } }, select: { createdAt: true, membershipStatus: true } }),
    db.event.findMany({ where: { startsAt: { gte: now } }, orderBy: { startsAt: 'asc' }, take: 5 }),
    db.attendance.count({ where: { checkedInAt: { gte: new Date(now - 7 * DAY) } } }),
    Promise.all(attWeeks.map((w) => db.attendance.count({ where: { checkedInAt: { gte: w.start, lt: w.end } } }))),
    // Fetch extra rows when finance kinds must be filtered out, so the visible
    // list still fills up rather than being thinned by the filter.
    // More than six are read, because housekeeping entries are skipped below and should not push real ones out.
    db.activityLog.findMany({ orderBy: { occurredAt: 'desc' }, take: 80 }),
    db.member.groupBy({ by: ['membershipStatus'], where: { deletedAt: null }, _count: true }),
    // The "needs your attention" queues are only counted for people who can act on them.
    manager ? db.expense.aggregate({ where: { approvalStatus: 'SUBMITTED' }, _count: true, _sum: { amount: true } }) : Promise.resolve(null),
    manager ? db.cashCountSheet.count({ where: { status: 'COUNTED' } }) : Promise.resolve(0),
    manager ? db.bankDeposit.count({ where: { status: 'DEPOSITED' } }) : Promise.resolve(0),
    isAdmin ? db.member.count({ where: { deletedAt: null, email: null, mobilePhone: null } }) : Promise.resolve(0),
    canMoney ? ledger.incomeByDayAndAccount(db, churchId, { from: months[0].from, to: isoLocal(now) }) : Promise.resolve([]),
    // Raw SQL is not scoped by tenantDb, hence the explicit church_id. Prisma
    // cannot filter a date by month and day, which is what a birthday is.
    db.$queryRaw`
      SELECT member_id AS id, first_name AS "firstName", last_name AS "lastName",
             photo_filename AS "photoFilename", date_of_birth AS "dateOfBirth"
      FROM members
      WHERE church_id = ${churchId} AND deleted_at IS NULL AND date_of_birth IS NOT NULL
        AND membership_status::text NOT IN ('DECEASED', 'TRANSFERRED')
        AND to_char(date_of_birth, 'MM-DD') = ANY(${bdays.map((d) => d.key)})
      LIMIT 40`,
    canMoney ? Promise.resolve(0) : db.event.count({ where: { startsAt: { gte: now, lt: new Date(now.getTime() + 30 * DAY) } } }),
  ]);

  // ---- figures ----
  const expenseCount = expensesWaiting ? expensesWaiting._count : 0;
  const expenseTotal = expensesWaiting ? Number(expensesWaiting._sum.amount || 0) : 0;
  const createdIn = (from, to, statuses) => recentMembers.filter((m) => m.createdAt >= from && m.createdAt < to && (!statuses || statuses.includes(m.membershipStatus))).length;
  // Members on the roll at the end of each week, counted back from today.
  const memberSeries = weeks.map((w) => totalMembers - createdIn(w.end, new Date(now.getTime() + DAY), ACTIVE_STATUSES));
  const visitorSeries = weeks.map((w) => createdIn(w.start, w.end, ['VISITOR']));
  const visitorsThisMonth = createdIn(monthStart, new Date(now.getTime() + DAY), ['VISITOR']);
  const visitorsLastMonth = createdIn(lastMonthStart, lastMonthSamePoint, ['VISITOR']);
  const fullWeeks = weeklyAttendance.slice(0, -1);
  const thisWeekAttendance = weeklyAttendance[weeklyAttendance.length - 1];
  const fullWeekBuckets = attWeeks.slice(0, -1);
  const avgAttendance = fullWeeks.length ? sum(fullWeeks) / fullWeeks.length : 0;

  const bucketGiving = (buckets) => GIVING_SERIES.map((s, k) => ({
    cls: s.cls, name: s.name,
    values: buckets.map((b) => sum(incomeRows.filter((r) => inRange(r.day, b) && seriesFor(r.code) === k + 1).map((r) => r.amount))),
  })).filter((s) => s.values.some((v) => v !== 0) || s.cls === 's1');
  const givingWeekly = bucketGiving(weeks);
  const givingMonthly = bucketGiving(months);
  const givingThisMonth = sum(incomeRows.filter((r) => r.day >= isoLocal(monthStart)).map((r) => r.amount));
  const givingLastMonthSoFar = sum(incomeRows.filter((r) => r.day >= isoLocal(lastMonthStart) && r.day < isoLocal(lastMonthSamePoint)).map((r) => r.amount));
  const weeklyGivingTotals = weeks.map((_, i) => sum(givingWeekly.map((s) => s.values[i])));
  const monthName = now.toLocaleDateString('en-GB', { month: 'long' });

  // ---- header ----
  const hour = now.getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const rawName = firstName(user);
  // Accounts are often created in capitals ("ADMIN"); greet them in plain case.
  const name = rawName && rawName === rawName.toUpperCase() && rawName.length > 1 ? rawName[0] + rawName.slice(1).toLowerCase() : rawName;
  const churchName = (user.church && user.church.name) || 'your church';
  const actions = [`<a class="btn ghost" href="/events">${icon('events')} Calendar</a>`];
  if (isAdmin) actions.push(`<a class="btn ${canFinanceWrite(user) ? 'ghost' : ''}" href="/members/new">${icon('userPlus')} Add member</a>`);
  if (canFinanceWrite(user)) actions.push(`<a class="btn" href="/finance/income">${icon('plus')} Record income</a>`);
  const header = `<header class="pd-head">
    <div><p class="eyebrow">${esc(fmtDMY(now))}</p>
      <h1>${greeting}${name ? `, ${esc(name)}` : ''}</h1>
      <p class="sub">Here’s how ${esc(churchName)} is doing this week.</p></div>
    <div class="pd-actions">${actions.join('')}</div>
  </header>`;
  const callout = expenseCount ? `<div class="pd-callout" role="status">${icon('alert')}<span><b>${expenseCount} expense${expenseCount === 1 ? '' : 's'} totalling ${esc(cedis2(expenseTotal))}</b> ${expenseCount === 1 ? 'is' : 'are'} waiting for approval.</span><a href="/finance/expenses">Review ${icon('arrowRight')}</a></div>` : '';

  // ---- key figures ----
  const plusJoined = joinedThisMonth ? `<span class="pd-delta up">+${num(joinedThisMonth)}</span> joined this month` : 'No one new this month';
  const kpis = `<section class="pd-kpis" aria-label="Key figures">
    ${kpi({ href: '/members', ic: 'members', label: 'Active members', value: num(totalMembers), foot: plusJoined, spark: sparkline(memberSeries) })}
    ${kpi({ href: '/attendance', ic: 'attendance', label: 'Check-ins, last 7 days', value: num(last7Attendance), foot: avgAttendance ? `${delta(pctChange(last7Attendance, avgAttendance))} vs 12-week average` : 'No earlier weeks yet', spark: sparkline(fullWeeks) })}
    ${canMoney
      ? kpi({ href: '/finance', ic: 'banknote', label: `Giving, ${monthName}`, value: esc(cedis(givingThisMonth)), foot: givingLastMonthSoFar ? `${delta(pctChange(givingThisMonth, givingLastMonthSoFar))} vs last month so far` : 'From the finance ledger', spark: sparkline(weeklyGivingTotals) })
      : kpi({ href: '/events', ic: 'events', label: 'Events, next 30 days', value: num(eventsNext30), foot: upcomingEvents[0] ? `Next: ${esc(upcomingEvents[0].title)}, ${esc(fmtDMY(upcomingEvents[0].startsAt))}` : 'Nothing scheduled', spark: '' })}
    ${kpi({ href: '/members?status=VISITOR', ic: 'userPlus', label: `New visitors, ${monthName}`, value: num(visitorsThisMonth), foot: visitorsLastMonth ? `${delta(pctChange(visitorsThisMonth, visitorsLastMonth))} vs last month so far` : 'Added to the roll this month', spark: sparkline(visitorSeries) })}
  </section>`;

  // ---- giving (or attendance, for people without finance access) ----
  const legend = (series) => `<div class="pd-legend">${series.map((s) => `<span><i class="${s.cls}"></i>${esc(s.name)}</span>`).join('')}</div>`;
  let mainCard;
  if (canMoney) {
    const totalW = sum(givingWeekly.flatMap((s) => s.values)), totalM = sum(givingMonthly.flatMap((s) => s.values));
    const nothing = !incomeRows.length;
    mainCard = `<section class="pd-card flex" id="pdGiving">
      <div class="pd-ch">
        <div><h2>Giving</h2><p class="pd-big"><span data-total>${esc(cedis(totalW))}</span> <small data-total-label>last 12 weeks</small></p></div>
        <div class="pd-seg" role="group" aria-label="Range"><button type="button" data-range="w" data-total="${esc(cedis(totalW))}" data-label="last 12 weeks" aria-pressed="true">12 weeks</button><button type="button" data-range="m" data-total="${esc(cedis(totalM))}" data-label="last 12 months" aria-pressed="false">12 months</button></div>
      </div>
      ${nothing ? '' : legend(givingMonthly.length > givingWeekly.length ? givingMonthly : givingWeekly)}
      <div class="pd-chart fill">${nothing
        ? '<div class="pd-empty"><b>No giving recorded yet</b>Tithes, offerings and other income will appear here once they are posted.</div>'
        : `<div data-chart="w">${barChart({ buckets: weeks, series: givingWeekly, fmt: cedis, label: 'Giving by type, last 12 weeks' })}</div><div data-chart="m" hidden>${barChart({ buckets: months, series: givingMonthly, fmt: cedis, label: 'Giving by type, last 12 months' })}</div>`}</div>
      ${scriptTag('dashboard-giving')}
    </section>`;
  } else {
    mainCard = `<section class="pd-card flex">
      <div class="pd-ch"><div><h2>Attendance</h2><p class="pd-big">${num(sum(fullWeeks))} <small>check-ins, last 12 weeks</small></p></div><a href="/attendance">Details</a></div>
      <div class="pd-chart fill">${sum(fullWeeks)
        ? barChart({ buckets: fullWeekBuckets, series: [{ cls: 's1', name: 'Check-ins', values: fullWeeks }], fmt: num, label: 'Check-ins per week, last 12 weeks' })
        : '<div class="pd-empty"><b>No check-ins yet</b>Attendance from services and events will appear here.</div>'}</div>
    </section>`;
  }

  // ---- needs your attention ----
  const plural = (n, one, many) => `${num(n)} ${n === 1 ? one : many}`;
  const tasks = [];
  // Allowances drafted by the monthly run (lib/allowances.js) still waiting.
  const allowancesWaiting = manager ? await db.expense.aggregate({ where: { approvalStatus: 'SUBMITTED', allowanceRunId: { not: null } }, _count: true, _sum: { amount: true } }) : null;
  if (allowancesWaiting && allowancesWaiting._count) tasks.push({ href: '/finance/allowances', ic: 'users', tone: 'warn', title: `${plural(allowancesWaiting._count, 'allowance', 'allowances')} due for approval`, meta: `${cedis2(allowancesWaiting._sum.amount)} for workers this month` });
  if (expenseCount) tasks.push({ href: '/finance/expenses', ic: 'receipt', tone: 'warn', title: `${plural(expenseCount, 'expense', 'expenses')} waiting for approval`, meta: `${cedis2(expenseTotal)} in total` });
  if (countsWaiting) tasks.push({ href: '/finance/cash-counts', ic: 'banknote', tone: 'accent', title: `${plural(countsWaiting, 'cash count', 'cash counts')} to verify`, meta: 'Needs a second signature' });
  if (depositsWaiting) tasks.push({ href: '/finance/deposits', ic: 'finance', tone: 'info', title: `${plural(depositsWaiting, 'bank deposit', 'bank deposits')} to verify`, meta: 'Match against the bank statement' });
  if (isAdmin && visitorsThisMonth) tasks.push({ href: '/members?status=VISITOR', ic: 'userPlus', tone: 'ok', title: `${plural(visitorsThisMonth, 'new visitor', 'new visitors')} this month`, meta: 'Follow up and welcome them' });
  if (membersNoContact) tasks.push({ href: '/members', ic: 'alert', tone: 'bad', title: `${plural(membersNoContact, 'member has', 'members have')} no phone or email`, meta: 'They will miss broadcasts' });
  const attention = (manager || isAdmin) ? `<section class="pd-card">
      <div class="pd-ch"><h2>Needs attention</h2><span class="pd-count">${tasks.length}</span></div>
      ${tasks.length
        ? `<ul class="pd-list">${tasks.map((t) => `<li><a class="pd-row" href="${t.href}"><span class="pd-ti tone-${t.tone}">${icon(t.ic)}</span><span><b>${esc(t.title)}</b><small>${esc(t.meta)}</small></span><span class="go">${icon('chevronRight')}</span></a></li>`).join('')}</ul>`
        : `<div class="pd-clear">${icon('checkCircle')}<b>All clear</b>Approvals, counts and deposits are up to date.</div>`}
    </section>` : '';

  // ---- birthdays this week ----
  const order = new Map(bdays.map((d, i) => [d.key, i]));
  const birthdays = birthdayRows
    .map((m) => {
      const dob = new Date(m.dateOfBirth);
      const key = `${pad(dob.getUTCMonth() + 1)}-${pad(dob.getUTCDate())}`;
      const slot = bdays[order.get(key)];
      const age = dobHasYear(dob) ? slot.date.getFullYear() - dob.getUTCFullYear() : null;
      return { ...m, slot: order.get(key), when: order.get(key) === 0 ? 'Today' : fmtDMY(slot.date), age };
    })
    .sort((a, b) => a.slot - b.slot || a.firstName.localeCompare(b.firstName));
  const shown = birthdays.slice(0, 6);
  const birthdayCard = `<section class="pd-card">
      <div class="pd-ch"><div><h2>Birthdays this week</h2><p class="sub">${birthdays.length ? `${plural(birthdays.length, 'person', 'people')} · send a blessing` : 'Next 7 days'}</p></div><span class="pd-ti tone-warn">${icon('gift')}</span></div>
      ${shown.length
        ? `<ul class="pd-list">${shown.map((m) => `<li class="pd-row">${avatar(m)}<span><b><a href="/members/${m.id}" style="color:inherit;text-decoration:none">${esc(m.firstName)} ${esc(m.lastName)}</a></b><small>${esc(m.when)}${m.age && m.age > 0 && m.age < 120 ? ` · turns ${m.age}` : ''}</small></span>${isAdmin ? `<a class="btn ghost" href="/communications/broadcast?member_id=${m.id}">${icon('message')} Wish</a>` : ''}</li>`).join('')}</ul>
          ${birthdays.length > shown.length ? `<p class="pd-body" style="margin:0;padding-top:0;font-size:12.5px;color:var(--pc-text-3)">and ${num(birthdays.length - shown.length)} more this week</p>` : ''}`
        : '<div class="pd-clear" style="padding-top:18px">No birthdays in the next 7 days.<span style="font-size:12px">Add dates of birth on member profiles to see them here.</span></div>'}
    </section>`;

  // ---- attendance, upcoming, membership, activity ----
  const attendanceCard = `<section class="pd-card">
      <div class="pd-ch"><div><h2>Attendance</h2><p class="sub">Check-ins per week · last 12 full weeks</p></div><a href="/attendance">Details</a></div>
      <div class="pd-chart">${sum(fullWeeks) ? areaChart(fullWeeks, fullWeekBuckets, 'Check-ins per week, last 12 full weeks') : '<div class="pd-empty"><b>No check-ins yet</b>Attendance will appear here.</div>'}</div>
      <div class="pd-minis"><div class="pd-mini"><small>This week so far</small><b>${num(thisWeekAttendance)}</b></div><div class="pd-mini"><small>Weekly average</small><b>${num(avgAttendance)}</b></div></div>
    </section>`;
  const STATUS_COLOURS = { MEMBER: 'var(--pc-c1)', REGULAR: 'var(--pc-c2)', VISITOR: 'var(--pc-c3)', INACTIVE: 'var(--pc-line)' };
  const statusRows = membershipByStatus
    .map((r) => ({ key: r.membershipStatus, label: MEMBERSHIP_STATUS_LABELS[r.membershipStatus] || r.membershipStatus, count: r._count, colour: STATUS_COLOURS[r.membershipStatus] || 'var(--pc-text-3)' }))
    .sort((a, b) => b.count - a.count);
  const rollTotal = sum(statusRows.map((r) => r.count));
  const membership = rollTotal ? `<div class="pd-sec">Membership · ${num(rollTotal)} on the roll</div>
      <div class="pd-stackbar">${statusRows.map((r) => `<i style="width:${(r.count / rollTotal * 100).toFixed(2)}%;background:${r.colour}" title="${esc(r.label)}: ${num(r.count)}"></i>`).join('')}</div>
      ${statusRows.map((r) => `<div class="pd-mrow"><span class="sw" style="background:${r.colour}"></span>${esc(r.label)}<b>${num(r.count)}</b><small>${(r.count / rollTotal * 100).toFixed(1)}%</small></div>`).join('')}` : '';
  const upcomingCard = `<section class="pd-card">
      <div class="pd-ch"><div><h2>Upcoming events</h2><p class="sub">What’s next on the calendar</p></div><a href="/events">Calendar</a></div>
      ${upcomingEvents.length
        ? `<ul class="pd-list">${upcomingEvents.map((e) => `<li><a class="pd-row" href="/events/${e.id}"><span class="pd-date" aria-hidden="true">${icon('events')}</span><span><b>${esc(e.title)}</b><small>${esc(fmtDMY(e.startsAt))} · ${esc(e.startsAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }))}${e.location ? ` · ${esc(e.location)}` : ''}</small></span><span class="pd-chip">${esc(EVENT_TYPE_LABELS[e.eventType] || 'Event')}</span></a></li>`).join('')}</ul>`
        : `<div class="pd-clear" style="padding-top:18px">Your calendar is clear.${isAdmin ? ' <a href="/events/new">Schedule an event</a>' : ''}</div>`}
      ${membership ? `<div class="pd-body" style="padding-top:0">${membership}</div>` : ''}
    </section>`;
  const recentActivity = activityRows.filter((a) => showsInFeed(a.kind, canMoney)).slice(0, 6);
  const activityCard = `<section class="pd-card">
      <div class="pd-ch"><h2>Recent activity</h2></div>
      ${recentActivity.length
        ? `<ul class="pd-feed">${recentActivity.map((a) => { const [ic, tone] = activityIcon(a.kind); return `<li><span class="pd-ti tone-${tone}">${icon(ic)}</span><div><p>${a.link ? `<a href="${esc(a.link)}">${esc(a.description)}</a>` : esc(a.description)}</p><small>${esc(timeAgo(a.occurredAt, now))}</small></div></li>`; }).join('')}</ul>`
        : '<div class="pd-clear" style="padding-top:18px">Updates from your team will appear here.</div>'}
    </section>`;

  const lower = canMoney
    ? `<div class="pd-grid pd-3">${attendanceCard}${upcomingCard}${activityCard}</div>`
    : `<div class="pd-grid pd-2">${upcomingCard}${activityCard}</div>`;

  // An Admin or finance account can see or move the church's money, so a
  // stolen password there is the costly one. Remind them until it is on.
  const mfaNudge = hasFinanceAccess(user) && !user.totpEnabled
    ? `<div class="pd-callout" role="status">${icon('alert')}<span><b>Turn on two-factor authentication.</b> Your account can see or move the church's money, and a code from your phone keeps it safe if your password is ever stolen.</span><a href="/settings">Set it up ${icon('arrowRight')}</a></div>`
    : '';

  return `<div class="pd">${header}${mfaNudge}${callout}${sundayCard}${kpis}
    <div class="pd-grid pd-21">${mainCard}<div class="pd-stack">${attention}${birthdayCard}</div></div>
    ${lower}</div>`;
}

module.exports = { renderDashboard };
