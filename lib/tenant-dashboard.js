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
const { memberAvatar } = require('./views');
const { icon } = require('./icons');

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

// ---- charts (server-rendered SVG, no chart library) -----------------------

// Smooth line through the points (Catmull-Rom converted to cubic beziers).
function smoothPath(pts) {
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

function lineChart(rows) {
  const W = 620, H = 240, L = 44, R = 16, T = 22, B = 34;
  const max = Math.max(...rows.map((r) => r.count), 1);
  const top = Math.max(4, Math.ceil(max / 4) * 4); // round the y-axis up to a tidy figure
  const x = (i) => L + (rows.length === 1 ? (W - L - R) / 2 : i * (W - L - R) / (rows.length - 1));
  const y = (v) => T + (H - T - B) * (1 - v / top);
  const pts = rows.map((r, i) => [x(i), y(r.count)]);
  const line = smoothPath(pts);
  const area = `${line} L${x(rows.length - 1)},${H - B} L${x(0)},${H - B} Z`;
  const grid = [0, 1, 2, 3, 4].map((k) => {
    const v = top * k / 4, yy = y(v);
    return `<line class="gl" x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}"/><text class="yt" x="${L - 10}" y="${yy + 4}" text-anchor="end">${Math.round(v)}</text>`;
  }).join('');
  const xs = rows.map((r, i) => `<text class="xt" x="${x(i)}" y="${H - 8}" text-anchor="middle">${esc(r.short)}</text>`).join('');
  const dots = pts.map((pt, i) => `<circle class="dot${i === pts.length - 1 ? ' now' : ''}" cx="${pt[0]}" cy="${pt[1]}" r="${i === pts.length - 1 ? 6 : 4}" style="animation-delay:${0.6 + i * 0.1}s"><title>${esc(rows[i].short)}: ${rows[i].count}</title></circle>`).join('');
  return `<svg class="linechart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Check-ins per week, last ${rows.length} weeks" preserveAspectRatio="xMidYMid meet">
    <defs><linearGradient id="lcFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--pri)" stop-opacity=".28"/><stop offset="1" stop-color="var(--pri)" stop-opacity="0"/></linearGradient></defs>
    ${grid}${xs}
    <path class="area" d="${area}" fill="url(#lcFill)"/>
    <path class="ln" d="${line}" pathLength="1" fill="none" stroke="var(--pri)" stroke-width="3.5" stroke-linecap="round"/>
    ${dots}
  </svg>`;
}

const DONUT_COLORS = ['var(--pri)', 'var(--ok)', 'var(--warn)', 'var(--out)'];
function donut(rows) {
  const total = rows.reduce((s, r) => s + r.count, 0);
  if (!total) return '<p class="all-clear">No members yet.</p>';
  const R = 62, C = 2 * Math.PI * R, GAP = rows.length > 1 ? 5 : 0;
  let acc = 0;
  const segs = rows.slice(0, 4).map((r, i) => {
    const len = Math.max(1, r.count / total * C - GAP);
    const seg = `<circle class="seg" cx="90" cy="90" r="${R}" fill="none" stroke="${DONUT_COLORS[i]}" stroke-width="18" stroke-linecap="round" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-acc).toFixed(2)}" style="animation-delay:${0.2 + i * 0.12}s"/>`;
    acc += r.count / total * C;
    return seg;
  }).join('');
  const legend = rows.slice(0, 4).map((r, i) => `<li><i style="background:${DONUT_COLORS[i]}"></i>${esc(r.label)}<b>${r.count.toLocaleString()}</b></li>`).join('');
  return `<div class="donut">
    <svg viewBox="0 0 180 180" role="img" aria-label="Members by status"><circle cx="90" cy="90" r="${R}" fill="none" stroke="var(--sf-hi)" stroke-width="18"/><g transform="rotate(-90 90 90)">${segs}</g></svg>
    <div class="mid"><small>Total</small><b data-count="${total}">${total.toLocaleString()}</b></div>
  </div><ul class="legend">${legend}</ul>`;
}

// Big pastel tile with an icon: label, number (counts up on load), tinted glyph.
function tile(cls, iconName, label, valueHtml) {
  return `<div class="vt ${cls}"><div><small>${esc(label)}</small><strong>${valueHtml}</strong></div><span class="vt-ico" aria-hidden="true">${icon(iconName, { size: 44 })}</span></div>`;
}
const countUp = (n) => `<span data-count="${n}">${n.toLocaleString()}</span>`;

function activityIcon(kind) {
  const k = String(kind || '');
  if (FINANCE_ACTIVITY_KINDS.has(k)) return ['wallet', 'ok'];
  if (k.startsWith('member')) return ['members', 'pri'];
  if (k.startsWith('attendance') || k.includes('checkin')) return ['attendance', 'ter'];
  if (k.startsWith('event')) return ['events', 'sec'];
  return ['clock', 'sec'];
}

const timeAgo = (d, now) => {
  const days = Math.floor((now - d) / 86400000);
  if (days < 1) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
};

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
    expensesWaiting, countsWaiting, depositsWaiting, membersNoContact, newestMembers,
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
    db.member.findMany({ where: { deletedAt: null }, orderBy: { createdAt: 'desc' }, take: 5,
      select: { id: true, firstName: true, lastName: true, photoFilename: true, membershipStatus: true, joinDate: true, createdAt: true } }),
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
  const rawName = firstName(user);
  // Accounts are often created in capitals ("ADMIN"); greet them in plain case.
  const name = rawName && rawName === rawName.toUpperCase() && rawName.length > 1 ? rawName[0] + rawName.slice(1).toLowerCase() : rawName;
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

  // The next thing on the calendar, front and centre, with a live countdown.
  const next = upcomingEvents[0];
  const hero = next ? `<section class="dash-hero" data-start="${esc(next.startsAt.toISOString())}">
    <div>
      <p class="k">Next up</p>
      <h2>${esc(next.title)}</h2>
      <p>${esc(next.startsAt.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }))} · ${esc(next.startsAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }))}${next.location ? ` · ${esc(next.location)}` : ''} · <a class="go" href="/events/${next.id}">Details</a></p>
    </div>
    <div class="count" aria-label="Time until this event">
      <div><b data-u="d">–</b><small>days</small></div><div><b data-u="h">–</b><small>hours</small></div><div><b data-u="m">–</b><small>minutes</small></div>
    </div>
    <script>
      (function () {
        var box = document.currentScript.parentNode, start = new Date(box.getAttribute('data-start')).getTime();
        function tick() {
          var mins = Math.max(0, Math.floor((start - Date.now()) / 60000));
          box.querySelector('[data-u=d]').textContent = Math.floor(mins / 1440);
          box.querySelector('[data-u=h]').textContent = Math.floor(mins % 1440 / 60);
          box.querySelector('[data-u=m]').textContent = mins % 60;
        }
        tick(); setInterval(tick, 30000);
      })();
    </script>
  </section>` : '';

  const stats = `<div class="vt-row">
    ${tile('t1', 'members', 'Members', countUp(totalMembers))}
    ${tile('t2', 'star', 'New this month', countUp(newMembersThisMonth))}
    ${tile('t3', 'attendance', 'Check-ins, 7 days', countUp(recentAttendance))}
    ${canMoney ? tile('t4', 'finance', 'Income this month', esc(fmtMoney(incomeThisMonth._sum.amount || 0))) : tile('t4', 'lock', 'Finance', 'Restricted')}
  </div>`;

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

  const tints = ['pri', 'ter', 'ok', 'sec'];
  const upcoming = `
    <section class="dash-block">
      <div class="dash-block-head"><h2>Upcoming events</h2><a href="/events">All events →</a></div>
      ${upcomingEvents.length
        ? `<ul class="feed">${upcomingEvents.map((e, i) => `<li><span class="fi ${tints[i % 4]}">${icon('events', { size: 22 })}</span>
            <div><a href="/events/${e.id}">${esc(e.title)}</a>
            <small>${esc(e.startsAt.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }))} · ${esc(e.startsAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }))}${e.location ? ` · ${esc(e.location)}` : ''}</small></div></li>`).join('')}</ul>`
        : '<p class="all-clear">Your calendar is clear. <a href="/events/new">Schedule an event</a></p>'}
    </section>`;

  const activity = `
    <section class="dash-block">
      <h2>Recent activity</h2>
      ${recentActivity.length
        ? `<ul class="feed">${recentActivity.map((a) => { const [ic, tint] = activityIcon(a.kind); return `<li><span class="fi ${tint}">${icon(ic, { size: 22 })}</span>
            <div>${a.link ? `<a href="${esc(a.link)}">${esc(a.description)}</a>` : `<span>${esc(a.description)}</span>`}<small>${esc(timeAgo(a.occurredAt, now))}</small></div></li>`; }).join('')}</ul>`
        : '<p class="all-clear">Updates from your team will appear here.</p>'}
    </section>`;

  const trend = `
    <section class="dash-block chart-block">
      <div class="dash-block-head"><h2>Attendance</h2><span class="muted-text">Check-ins per week · last ${attendanceRows.length} weeks</span></div>
      ${lineChart(attendanceRows)}
    </section>`;
  const mix = `
    <section class="dash-block">
      <div class="dash-block-head"><h2>Membership</h2><a href="/reports">Reports →</a></div>
      ${donut(membershipBars)}
    </section>`;

  const statusLabel = (st) => MEMBERSHIP_STATUS_LABELS[st] || st;
  const newest = `
    <section class="dash-block">
      <div class="dash-block-head"><h2>Newest members</h2><a href="/members">All members →</a></div>
      ${newestMembers.length
        ? `<table class="dm-table"><thead><tr><th>Name</th><th>Status</th><th>Joined</th></tr></thead><tbody>${newestMembers.map((m) => `<tr>
            <td><a class="who" href="/members/${m.id}">${memberAvatar({ first_name: m.firstName, last_name: m.lastName, photo_filename: m.photoFilename })}<span>${esc(m.firstName)} ${esc(m.lastName)}</span></a></td>
            <td><span class="pill pill-other">${esc(statusLabel(m.membershipStatus))}</span></td>
            <td>${esc((m.joinDate || m.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }))}</td></tr>`).join('')}</tbody></table>`
        : '<p class="all-clear">No members yet. <a href="/members/new">Add the first one</a></p>'}
    </section>`;

  const countScript = `<script>
    (function () {
      var els = document.querySelectorAll('[data-count]');
      if (!els.length || (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches)) return;
      els.forEach(function (el) {
        var to = Number(el.getAttribute('data-count')), t0 = null;
        function step(t) {
          if (t0 === null) t0 = t;
          var p = Math.min(1, (t - t0) / 900), e = 1 - Math.pow(1 - p, 3);
          el.textContent = Math.round(to * e).toLocaleString();
          if (p < 1) requestAnimationFrame(step);
        }
        el.textContent = '0'; requestAnimationFrame(step);
      });
    })();
  </script>`;

  return `<div class="dash">${header}${hero}${stats}
    <div class="dash-grid wide"><div class="dash-col">${trend}</div><div class="dash-col">${mix}</div></div>
    <div class="dash-grid">
      <div class="dash-col">${attention}${newest}</div>
      <div class="dash-col">${upcoming}${activity}</div>
    </div>${countScript}</div>`;
}

module.exports = { renderDashboard };
