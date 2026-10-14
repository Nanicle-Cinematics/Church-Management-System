'use strict';
// Finance > Allowances: workers paid a fixed allowance every month, the due
// day, and each month's run (see lib/allowances.js). Anyone with finance
// access can view; fund managers (Admin, Finance Admin, Treasurer) manage the
// list and settings and can draft a month by hand. Also turns device
// notifications on for this browser (lib/push.js, public/sw.js).

const asyncHandler = require('../lib/async-handler');
const { esc, fmtMoney } = require('../lib/format');
const { pageHero, statsRow, table } = require('../lib/views');
const { flash } = require('../lib/tenant-flash');
const { logActivity } = require('../lib/tenant-activity');
const { icon } = require('../lib/icons');
const { normalizePhone } = require('../lib/phone');
const allowances = require('../lib/allowances');
const { pushReady, vapidPublicKey } = require('../lib/push');

const canView = (u) => Boolean(u && (u.role === 'ADMIN' || (u.financeRole && u.financeRole !== 'NONE')));
const canManage = (u) => Boolean(u && (u.role === 'ADMIN' || ['FINANCE_ADMIN', 'TREASURER'].includes(u.financeRole)));

function requireView(req, res, next) {
  if (!res.locals.user) return res.redirect('/login');
  if (canView(res.locals.user)) return next();
  return res.status(403).send('Finance access required');
}
function requireManage(req, res, next) {
  if (canManage(res.locals.user)) return next();
  return res.status(403).send('Forbidden');
}

const STATUS_PILL = { SUBMITTED: ['pending', 'Waiting'], PAID: ['fulfilled', 'Paid'], APPROVED: ['fulfilled', 'Approved'], REJECTED: ['overdue', 'Rejected'] };
const pill = (status) => { const [cls, label] = STATUS_PILL[status] || ['pending', status]; return `<span class="pill pill-${cls}">${esc(label)}</span>`; };
const ordinal = (n) => `${n}${['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th'}`;
const shortDate = (d) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** Read and check an allowance form. Returns { data } or { error }. */
async function readForm(db, b) {
  const amount = Number(b.amount);
  if (!(amount > 0) || amount > 10_000_000) return { error: 'Enter a monthly amount greater than 0.' };
  let member = null;
  if (b.memberId) {
    member = await db.member.findUnique({ where: { id: Number(b.memberId) } });
    if (!member) return { error: 'That member was not found.' };
  }
  const payeeName = String(b.payeeName || '').trim().slice(0, 120) || (member ? `${member.firstName} ${member.lastName}` : '');
  if (!payeeName) return { error: 'Choose a member or type the worker\'s name.' };
  let fundId = null;
  if (b.fundId) {
    const fund = await db.fund.findUnique({ where: { id: Number(b.fundId) } });
    if (!fund) return { error: 'That fund was not found.' };
    fundId = fund.id;
  }
  let expenseCatId = null;
  if (b.expenseCatId) {
    const cat = await db.expenseCategory.findUnique({ where: { id: Number(b.expenseCatId) } });
    if (!cat) return { error: 'That expense category was not found.' };
    expenseCatId = cat.id;
  }
  return {
    data: {
      memberId: member ? member.id : null, payeeName, role: String(b.role || '').trim().slice(0, 80) || null,
      amount, fundId, expenseCatId, notes: String(b.notes || '').trim().slice(0, 500) || null,
    },
  };
}

async function formOptions(db) {
  const [members, funds, cats] = await Promise.all([
    db.member.findMany({ where: { deletedAt: null }, orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }], select: { id: true, firstName: true, lastName: true }, take: 2000 }),
    db.fund.findMany({ where: { active: true }, orderBy: { name: 'asc' } }),
    db.expenseCategory.findMany({ where: { isActive: true }, orderBy: { categoryName: 'asc' } }),
  ]);
  return { members, funds, cats };
}

function allowanceFields({ members, funds, cats }, a = {}) {
  const opt = (v, label, sel) => `<option value="${v}" ${String(sel ?? '') === String(v) ? 'selected' : ''}>${esc(label)}</option>`;
  return `
    <label>Member<select name="memberId"><option value="">Not a member / type a name</option>${members.map((m) => opt(m.id, `${m.firstName} ${m.lastName}`, a.memberId)).join('')}</select></label>
    <label>Name<input name="payeeName" maxlength="120" value="${esc(a.payeeName || '')}" placeholder="Taken from the member if left blank"></label>
    <label>Role<input name="role" maxlength="80" value="${esc(a.role || '')}" placeholder="e.g. Caretaker, Organist"></label>
    <label>Monthly amount (GH₵)<input type="number" step="0.01" min="0.01" name="amount" required value="${a.amount != null ? esc(Number(a.amount).toFixed(2)) : ''}"></label>
    <label>Paid from fund<select name="fundId"><option value="">Default fund</option>${funds.map((f) => opt(f.id, f.name, a.fundId)).join('')}</select></label>
    <label>Expense category<select name="expenseCatId"><option value="">Allowances</option>${cats.map((c) => opt(c.id, c.categoryName, a.expenseCatId)).join('')}</select></label>
    <label class="wide">Notes<input name="notes" maxlength="500" value="${esc(a.notes || '')}"></label>`;
}

// Turns device notifications on for this browser. Shown only when push is
// set up (VAPID keys); the service worker is /sw.js.
function notificationsCard() {
  if (!pushReady()) return '';
  return `<section class="card" id="pushCard">
      <div class="card-head"><h2>Notifications on this device</h2><span class="meta">Alerts appear like any other app's</span></div>
      <p class="muted-text" id="pushState">Checking…</p>
      <div class="actions"><button type="button" id="pushOn" style="display:none">Turn on notifications</button><button type="button" class="btn ghost" id="pushOff" style="display:none">Turn off on this device</button></div>
      <p class="muted-text" id="pushIos" style="display:none">On iPhone or iPad: tap Share, then <b>Add to Home Screen</b>, open the app from there, and turn notifications on.</p>
    </section>
    <script>
    (function () {
      var key = ${JSON.stringify(vapidPublicKey())};
      var state = document.getElementById('pushState'), on = document.getElementById('pushOn'), off = document.getElementById('pushOff');
      // The theme sets display on buttons, so the hidden attribute alone does not hide them.
      function show(text, canOn, canOff) { state.textContent = text; on.style.display = canOn ? '' : 'none'; off.style.display = canOff ? '' : 'none'; }
      function b64(s) { var p = '='.repeat((4 - s.length % 4) % 4); var raw = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); var a = new Uint8Array(raw.length); for (var i = 0; i < raw.length; i++) a[i] = raw.charCodeAt(i); return a; }
      function post(url, body) { return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); }
      var ios = /iphone|ipad|ipod/i.test(navigator.userAgent), standalone = window.navigator.standalone || matchMedia('(display-mode: standalone)').matches;
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        show(ios && !standalone ? 'Add this app to your Home Screen to get notifications on this device.' : 'This browser cannot show notifications.', false, false);
        document.getElementById('pushIos').style.display = ios && !standalone ? '' : 'none';
        return;
      }
      navigator.serviceWorker.register('/sw.js').then(function (reg) { return reg.pushManager.getSubscription(); }).then(function (sub) {
        if (Notification.permission === 'denied') show('Notifications are blocked for this site. Allow them in your browser or phone settings, then reload.', false, false);
        else if (sub) { post('/api/push/subscribe', sub.toJSON()); show('Notifications are on for this device.', false, true); }
        else show('Get allowance alerts on this device, even when the app is closed.', true, false);
      });
      on.addEventListener('click', function () {
        on.disabled = true;
        Notification.requestPermission().then(function (p) {
          if (p !== 'granted') { on.disabled = false; return show('Notifications were not allowed.', true, false); }
          return navigator.serviceWorker.ready.then(function (reg) { return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(key) }); })
            .then(function (sub) { return post('/api/push/subscribe', sub.toJSON()); })
            .then(function (r) { on.disabled = false; if (!r.ok) throw new Error(); show('Notifications are on for this device.', false, true); });
        }).catch(function () { on.disabled = false; show('Could not turn notifications on. Try again.', true, false); });
      });
      off.addEventListener('click', function () {
        navigator.serviceWorker.ready.then(function (reg) { return reg.pushManager.getSubscription(); }).then(function (sub) {
          if (!sub) return;
          return post('/api/push/unsubscribe', { endpoint: sub.endpoint }).then(function () { return sub.unsubscribe(); });
        }).then(function () { show('Notifications are off for this device.', true, false); });
      });
    })();
    </script>`;
}

function register(app) {
  app.get('/finance/allowances', requireView, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const manage = canManage(res.locals.user);
    const now = new Date();
    const period = allowances.periodOf(now);
    const [list, settings, runs, opts] = await Promise.all([
      db.allowance.findMany({ orderBy: [{ active: 'desc' }, { payeeName: 'asc' }], include: { fund: true, member: { select: { id: true } } } }),
      db.financeSetting.findFirst(),
      db.allowanceRun.findMany({ orderBy: { period: 'desc' }, take: 6, include: { expenses: { select: { id: true, approvalStatus: true, amount: true, paidTo: true } } } }),
      manage ? formOptions(db) : Promise.resolve(null),
    ]);
    const active = list.filter((a) => a.active);
    const monthly = active.reduce((s, a) => s + Number(a.amount), 0);
    const dueDay = settings && settings.allowanceDueDay;
    const thisRun = runs.find((r) => r.period === period);
    let nextDue = null;
    if (dueDay) {
      const due = allowances.dueDateFor(period, dueDay);
      nextDue = thisRun || due < new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
        ? allowances.dueDateFor(allowances.periodOf(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))), dueDay)
        : due;
    }

    const stats = statsRow([
      { cls: 'blue', icon: icon('users'), value: active.length, label: 'Active workers' },
      { cls: 'green', icon: icon('wallet'), value: fmtMoney(monthly), label: 'Paid each month' },
      { cls: 'orange', icon: icon('clock'), value: nextDue ? shortDate(nextDue) : 'Not set', label: 'Next due' },
    ]);

    // This month
    let monthCard;
    if (thisRun) {
      const waiting = thisRun.expenses.filter((e) => e.approvalStatus === 'SUBMITTED');
      monthCard = `<section class="card">
        <div class="card-head"><h2>${esc(allowances.periodLabel(period))}</h2><span class="meta">Drafted ${esc(shortDate(thisRun.createdAt))}</span></div>
        <p>${waiting.length
          ? `<b>${waiting.length} of ${thisRun.expenses.length}</b> waiting for approval (${esc(fmtMoney(waiting.reduce((s, e) => s + Number(e.amount), 0)))}). <a href="/finance/expenses">Approve them in Expenses →</a>`
          : `All ${thisRun.expenses.length} settled.`}</p>
        ${table(['Worker', 'Amount', 'Status'], thisRun.expenses.map((e) => [esc(e.paidTo || '—'), fmtMoney(e.amount), pill(e.approvalStatus)]))}
      </section>`;
    } else {
      monthCard = `<section class="card">
        <div class="card-head"><h2>${esc(allowances.periodLabel(period))}</h2><span class="meta">Not drafted yet</span></div>
        <p class="muted-text">${dueDay ? `This month's allowances will be drafted on the ${esc(ordinal(dueDay))} and sent for approval, and approvers will be alerted.` : 'Set a due day below to have allowances drafted automatically each month.'}</p>
        ${manage && active.length ? `<form method="post" action="/finance/allowances/run"><button type="submit">Draft ${esc(allowances.periodLabel(period))} now</button></form>` : ''}
      </section>`;
    }

    const rows = list.map((a) => [
      `<b>${a.member ? `<a href="/members/${a.member.id}">${esc(a.payeeName)}</a>` : esc(a.payeeName)}</b>`,
      esc(a.role || '—'), fmtMoney(a.amount), esc(a.fund ? a.fund.name : 'Default fund'),
      a.active ? '<span class="pill pill-fulfilled">Active</span>' : '<span class="pill pill-pending">Paused</span>',
      ...(manage ? [`<div class="al-actions"><a class="btn ghost" href="/finance/allowances/${a.id}/edit">Edit</a>
        <form method="post" action="/finance/allowances/${a.id}/active"><input type="hidden" name="active" value="${a.active ? '0' : '1'}"><button type="submit" class="btn ghost">${a.active ? 'Pause' : 'Resume'}</button></form></div>`] : []),
    ]);
    const addForm = manage ? `<details class="form-toggle" style="margin-bottom:1rem">
        <summary><strong>+ Add a worker</strong></summary>
        <form class="form" method="post" action="/finance/allowances" style="margin-top:0.75rem">
          ${allowanceFields(opts)}
          <div class="actions"><button type="submit">Save</button></div>
        </form>
      </details>` : '';

    const history = runs.filter((r) => r.period !== period);
    const historyCard = history.length ? `<section class="card">
        <div class="card-head"><h2>Earlier months</h2></div>
        ${table(['Month', 'Workers', 'Total', 'Paid', 'Waiting'], history.map((r) => [
          esc(allowances.periodLabel(r.period)), r.workerCount, fmtMoney(r.total),
          r.expenses.filter((e) => e.approvalStatus === 'PAID' || e.approvalStatus === 'APPROVED').length,
          r.expenses.filter((e) => e.approvalStatus === 'SUBMITTED').length,
        ]))}
      </section>` : '';

    const dis = manage ? '' : 'disabled';
    const settingsCard = `<section class="card">
        <div class="card-head"><h2>Due day and alerts</h2><span class="meta">Who is told, and when</span></div>
        <form class="form" method="post" action="/finance/allowances/settings">
          <label>Due day of the month<select name="dueDay" ${dis}><option value="">Off (draft by hand)</option>${Array.from({ length: 31 }, (_, i) => i + 1).map((d) => `<option value="${d}" ${dueDay === d ? 'selected' : ''}>${ordinal(d)}${d > 28 ? ' (or the last day)' : ''}</option>`).join('')}</select></label>
          <label>Also text these numbers<input name="alertPhones" maxlength="300" value="${esc((settings && settings.allowanceAlertPhones) || '')}" placeholder="024 412 7781, 020 555 1234" ${dis}></label>
          ${manage ? '<div class="actions"><button type="submit">Save</button></div>' : ''}
        </form>
        <p class="muted-text">On the due day Treasurers, Finance admins and Admins get an email, a text message (to the phone they sign in with, and the numbers above) and a notification on each device where they turned notifications on. If any allowance is still unpaid five days later they are reminded once.</p>
        ${manage ? `<form method="post" action="/finance/allowances/test-alert"><button type="submit" class="btn ghost">Send me a test alert</button></form>` : ''}
      </section>`;

    const body = `${pageHero('Allowances', 'Monthly allowances for church workers')}
      ${stats}
      ${monthCard}
      ${addForm}
      <section class="card">
        <div class="card-head"><h2>Workers</h2><span class="meta">${list.length} on the list</span></div>
        ${rows.length ? table(['Worker', 'Role', 'Monthly', 'Fund', 'Status', ...(manage ? [''] : [])], rows) : '<p class="muted-text">No workers yet.</p>'}
      </section>
      ${settingsCard}
      ${notificationsCard()}
      ${historyCard}`;
    res.page({ title: 'Finance · Allowances', active: '/finance', noHeader: true, body });
  }));

  app.post('/finance/allowances', requireManage, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const { data, error } = await readForm(db, req.body || {});
    if (error) { flash(req, error); return res.redirect('/finance/allowances'); }
    await db.allowance.create({ data });
    await logActivity(db, 'allowance_added', `Allowance added: ${data.payeeName} (${fmtMoney(data.amount)} a month)`, '/finance/allowances', res.locals.user.id);
    flash(req, `${data.payeeName} added.`, 'success');
    res.redirect('/finance/allowances');
  }));

  app.get('/finance/allowances/:id(\\d+)/edit', requireManage, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const a = await db.allowance.findUnique({ where: { id: Number(req.params.id) } });
    if (!a) return res.status(404).send('Not found');
    const body = `${pageHero(`Edit ${a.payeeName}`, 'Changes apply from the next month drafted')}
      <section class="card"><form class="form" method="post" action="/finance/allowances/${a.id}">
        ${allowanceFields(await formOptions(db), a)}
        <div class="actions"><button type="submit">Save</button><a class="btn ghost" href="/finance/allowances">Cancel</a></div>
      </form></section>`;
    res.page({ title: 'Finance · Edit allowance', active: '/finance', noHeader: true, body });
  }));

  app.post('/finance/allowances/:id(\\d+)', requireManage, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const id = Number(req.params.id);
    if (!(await db.allowance.findUnique({ where: { id } }))) return res.status(404).send('Not found');
    const { data, error } = await readForm(db, req.body || {});
    if (error) { flash(req, error); return res.redirect(`/finance/allowances/${id}/edit`); }
    await db.allowance.update({ where: { id }, data });
    await logActivity(db, 'allowance_edited', `Allowance changed: ${data.payeeName} (${fmtMoney(data.amount)} a month)`, '/finance/allowances', res.locals.user.id);
    flash(req, 'Saved.', 'success');
    res.redirect('/finance/allowances');
  }));

  app.post('/finance/allowances/:id(\\d+)/active', requireManage, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const a = await db.allowance.findUnique({ where: { id: Number(req.params.id) } });
    if (!a) return res.status(404).send('Not found');
    const active = req.body.active === '1';
    await db.allowance.update({ where: { id: a.id }, data: { active } });
    await logActivity(db, 'allowance_edited', `Allowance ${active ? 'resumed' : 'paused'}: ${a.payeeName}`, '/finance/allowances', res.locals.user.id);
    flash(req, `${a.payeeName} ${active ? 'resumed' : 'paused'}.`, 'success');
    res.redirect('/finance/allowances');
  }));

  app.post('/finance/allowances/settings', requireManage, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const b = req.body || {};
    const dueDay = b.dueDay ? Number(b.dueDay) : null;
    if (dueDay !== null && !(Number.isInteger(dueDay) && dueDay >= 1 && dueDay <= 31)) { flash(req, 'Choose a day from 1 to 31.'); return res.redirect('/finance/allowances'); }
    const phones = String(b.alertPhones || '').split(/[,;\n]/).map((p) => p.trim()).filter(Boolean);
    const bad = phones.find((p) => !normalizePhone(p));
    if (bad) { flash(req, `"${bad}" does not look like a phone number.`); return res.redirect('/finance/allowances'); }
    const data = { allowanceDueDay: dueDay, allowanceAlertPhones: phones.length ? phones.map(normalizePhone).join(', ') : null };
    if (await db.financeSetting.findFirst()) await db.financeSetting.update({ where: { churchId: res.locals.churchId }, data });
    else await db.financeSetting.create({ data });
    await logActivity(db, 'allowance_settings_updated', dueDay ? `Allowances due on the ${ordinal(dueDay)} of each month` : 'Allowances set to draft by hand', '/finance/allowances', res.locals.user.id);
    flash(req, 'Saved.', 'success');
    res.redirect('/finance/allowances');
  }));

  app.post('/finance/allowances/run', requireManage, asyncHandler(async (req, res) => {
    const period = allowances.periodOf(new Date());
    const run = await allowances.createRun(res.locals.churchId, period, { createdBy: res.locals.user.id });
    if (!run) { flash(req, `${allowances.periodLabel(period)} is already drafted, or no worker is active.`); return res.redirect('/finance/allowances'); }
    await allowances.announceRun(res.locals.churchId, run);
    flash(req, `${allowances.periodLabel(period)} allowances drafted and sent for approval.`, 'success');
    res.redirect('/finance/allowances');
  }));

  app.post('/finance/allowances/test-alert', requireManage, asyncHandler(async (req, res) => {
    const u = res.locals.user;
    const r = await allowances.alertUsers(res.locals.churchId, [u], {
      title: 'Test alert from Allowances',
      text: 'This is a test alert. Allowance alerts will arrive like this.',
      url: '/finance/allowances',
    });
    const parts = [];
    parts.push(r.email && r.email.sent ? 'email sent' : (r.email && r.email.dryRun ? 'email not set up' : (u.email ? 'email failed' : 'no email on your account')));
    parts.push(r.sms && r.sms.ok && r.sms.sent ? 'text sent' : (r.sms && r.sms.dryRun ? 'text messages not set up' : (u.phone ? 'text failed' : 'no phone on your account')));
    parts.push(r.push && r.push.sent ? `notification sent to ${r.push.sent} device${r.push.sent === 1 ? '' : 's'}` : 'no device has notifications on');
    flash(req, `Test alert: ${parts.join(', ')}.`, 'success');
    res.redirect('/finance/allowances');
  }));
}

module.exports = { register };
