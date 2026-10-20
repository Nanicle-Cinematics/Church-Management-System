'use strict';
// Platform › Payments: what churches have paid for their plans, recorded by
// an operator (Mobile Money, bank, cash), with revenue by month and who has
// lapsed without renewing. Recording a payment can extend the church's Pro
// plan by the months it covers (lib/pro-renewals.js extendedUntil).
//
// Payments are platform rows (PlatformPayment), not church-owned: they keep
// the church's name and survive the church being deleted and purged.

const asyncHandler = require('../lib/async-handler');
const { esc } = require('../lib/format');
const { pageHero, statsRow, listCard, table } = require('../lib/views');
const { flash } = require('../lib/tenant-flash');
const { db: rawDb } = require('../lib/tenant');
const { icon } = require('../lib/icons');
const { operatorLayout } = require('../lib/operator-shell');
const { requireOperator, logPlatformEvent } = require('../lib/platform-operators');
const { requestIp, requestUserAgent } = require('../lib/security-audit');
const { renewalsOverview, extendedUntil } = require('../lib/pro-renewals');

const METHODS = { MOMO: 'Mobile Money', BANK: 'Bank transfer', CASH: 'Cash', OTHER: 'Other' };
const MONTH_CHOICES = [0, 1, 3, 6, 12];

const isoDate = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
const ghs = (n) => `GH₵ ${Number(n || 0).toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const monthKey = (d) => new Date(d).toISOString().slice(0, 7);
const monthLabel = (key) => new Date(`${key}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });

function page(res, opts) {
  return res.send(operatorLayout({ ...opts, operator: res.locals.operator, flash: res.locals.flash, flashType: res.locals.flashType }));
}

/** Revenue figures from a list of payments: by month for the last 12, and headline totals. */
function revenueSummary(payments, now = new Date()) {
  const thisMonth = monthKey(now);
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const lastMonth = monthKey(last);
  const year = String(now.getUTCFullYear());
  const months = [];
  for (let i = 11; i >= 0; i--) months.push(monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))));
  const byMonth = Object.fromEntries(months.map((m) => [m, 0]));
  let total = 0, month = 0, previous = 0, ytd = 0;
  for (const p of payments) {
    const amount = Number(p.amount);
    const key = monthKey(p.paidOn);
    total += amount;
    if (key === thisMonth) month += amount;
    if (key === lastMonth) previous += amount;
    if (key.startsWith(year)) ytd += amount;
    if (key in byMonth) byMonth[key] += amount;
  }
  return { total, month, previous, ytd, byMonth };
}

function monthBars(byMonth) {
  const entries = Object.entries(byMonth);
  const max = Math.max(1, ...entries.map(([, v]) => v));
  return `<div class="op-bars" role="img" aria-label="Revenue for each of the last 12 months">${entries.map(([key, v]) => `
    <div class="op-bar" title="${esc(monthLabel(key))}: ${esc(ghs(v))}"><span style="height:${Math.max(v ? 4 : 0, Math.round((v / max) * 100))}%"></span><small>${esc(monthLabel(key).split(' ')[0])}</small></div>`).join('')}</div>`;
}

async function recordForm(selectedChurchId) {
  const churches = await rawDb.church.findMany({ where: { deletedAt: null }, orderBy: { name: 'asc' }, select: { id: true, name: true, slug: true } });
  return `
    <section class="card" id="record">
      <div class="card-head"><h2>Record a payment</h2></div>
      <form class="form" method="post" action="/platform/payments">
        <label class="wide">Church<select name="churchId" required>
          <option value="">Choose a church…</option>
          ${churches.map((c) => `<option value="${esc(c.id)}"${c.id === selectedChurchId ? ' selected' : ''}>${esc(c.name)} (${esc(c.slug)})</option>`).join('')}
        </select></label>
        <label>Amount (GH₵)<input name="amount" type="number" min="0.01" step="0.01" required inputmode="decimal"></label>
        <label>Paid on<input name="paidOn" type="date" required value="${isoDate(new Date())}"></label>
        <label>Method<select name="method">${Object.entries(METHODS).map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select></label>
        <label>Reference<input name="reference" maxlength="100" placeholder="e.g. MoMo transaction ID"></label>
        <label>Covers<select name="months">${MONTH_CHOICES.map((m) => `<option value="${m}"${m === 12 ? ' selected' : ''}>${m ? `${m} month${m === 1 ? '' : 's'} of Pro` : 'Not a plan period'}</option>`).join('')}</select></label>
        <label class="check"><input type="checkbox" name="extend" value="1" checked> Extend their Pro plan by these months</label>
        <label class="wide">Note<input name="note" maxlength="300"></label>
        <div class="actions"><button type="submit">Record payment</button></div>
      </form>
    </section>`;
}

async function renderPayments(req, res) {
  const now = new Date();
  const [payments, renewals] = await Promise.all([
    rawDb.platformPayment.findMany({ orderBy: [{ paidOn: 'desc' }, { id: 'desc' }], take: 2000 }),
    renewalsOverview(now),
  ]);
  const summary = revenueSummary(payments, now);
  const lapsed = renewals.filter((r) => r.lapsed);

  const rows = payments.slice(0, 200).map((p) => [
    esc(isoDate(p.paidOn)),
    p.payerChurchId ? `<a href="/platform/churches/${esc(p.payerChurchId)}">${esc(p.churchName)}</a>` : `${esc(p.churchName)} <small class="muted-text">(deleted)</small>`,
    `<strong>${esc(ghs(p.amount))}</strong>`,
    esc(METHODS[p.method] || p.method),
    esc(p.reference || '—'),
    esc(p.months ? `${p.months} mo` : '—'),
    esc(p.recordedBy || '—'),
    `<form method="post" action="/platform/payments/${p.id}/delete" data-confirm="Delete this payment record? It does not change the church's plan.">
      <button class="link danger" type="submit">Delete</button></form>`,
  ]);

  // Per church: everything paid, and the last payment.
  const perChurch = new Map();
  for (const p of payments) {
    const key = p.payerChurchId || `deleted:${p.churchName}`;
    const e = perChurch.get(key) || { name: p.churchName, id: p.payerChurchId, total: 0, last: p.paidOn, count: 0 };
    e.total += Number(p.amount); e.count += 1;
    if (new Date(p.paidOn) > new Date(e.last)) e.last = p.paidOn;
    perChurch.set(key, e);
  }
  const churchRows = [...perChurch.values()].sort((a, b) => b.total - a.total).map((e) => [
    e.id ? `<a href="/platform/churches/${esc(e.id)}">${esc(e.name)}</a>` : `${esc(e.name)} <small class="muted-text">(deleted)</small>`,
    `<strong>${esc(ghs(e.total))}</strong>`, String(e.count), esc(isoDate(e.last)),
  ]);

  const lapsedRows = lapsed.map((c) => [
    `<a href="/platform/churches/${c.id}">${esc(c.name)}</a>`,
    `${esc(isoDate(c.proUntil))} <span class="pill pill-failed">${Math.abs(c.daysLeft)} day${Math.abs(c.daysLeft) === 1 ? '' : 's'} ago</span>`,
    `<a class="btn ghost" href="/platform/payments?church=${encodeURIComponent(c.id)}#record">Record payment</a>`,
  ]);

  const body = `
    ${pageHero('Payments', 'What churches have paid for their plans, and revenue by month.')}
    ${statsRow([
      { cls: 'green', icon: icon('wallet'), value: esc(ghs(summary.month)), label: 'This month' },
      { cls: 'blue', icon: icon('clock'), value: esc(ghs(summary.previous)), label: 'Last month' },
      { cls: 'gold', icon: icon('trend'), value: esc(ghs(summary.ytd)), label: `So far in ${now.getUTCFullYear()}` },
      { cls: 'purple', icon: icon('banknote'), value: esc(ghs(summary.total)), label: 'All time' },
    ])}
    <section class="card"><div class="card-head"><h2>Last 12 months</h2></div>${monthBars(summary.byMonth)}</section>
    ${lapsedRows.length ? listCard({
      title: 'Lapsed, not renewed', count: lapsedRows.length, countLabel: lapsedRows.length === 1 ? 'church' : 'churches',
      note: 'Pro plans that ended in the last 60 days. They are on Free until they pay.',
      inner: table(['Church', 'Pro ended', ''], lapsedRows, { keyCols: 2 }),
    }) : ''}
    ${await recordForm(String(req.query.church || ''))}
    ${listCard({
      title: 'Payments', count: payments.length, countLabel: payments.length === 1 ? 'payment' : 'payments',
      note: payments.length > 200 ? 'Showing the latest 200' : '',
      inner: rows.length ? table(['Paid on', 'Church', 'Amount', 'Method', 'Reference', 'Covers', 'Recorded by', ''], rows, { keyCols: 3 }) : '<p class="muted-text">No payments recorded yet.</p>',
    })}
    ${churchRows.length ? listCard({ title: 'By church', count: churchRows.length, countLabel: 'churches', inner: table(['Church', 'Paid in total', 'Payments', 'Last paid'], churchRows, { keyCols: 2 }) }) : ''}`;
  page(res, { title: 'Payments', active: '/platform/payments', body });
}

function register(app) {
  app.get('/platform/payments', requireOperator, asyncHandler(renderPayments));

  app.post('/platform/payments', requireOperator, asyncHandler(async (req, res) => {
    const b = req.body || {};
    const back = `/platform/payments${b.churchId ? `?church=${encodeURIComponent(b.churchId)}` : ''}#record`;
    const amount = Number(b.amount);
    const months = Number(b.months || 0);
    const paidOn = /^\d{4}-\d{2}-\d{2}$/.test(String(b.paidOn || '')) ? new Date(`${b.paidOn}T00:00:00Z`) : null;
    if (!(amount > 0) || amount > 1e9) { flash(req, 'Enter the amount paid.'); return res.redirect(back); }
    if (!paidOn || Number.isNaN(paidOn.getTime()) || paidOn > new Date(Date.now() + 86400000)) { flash(req, 'Enter the date it was paid (not in the future).'); return res.redirect(back); }
    if (!MONTH_CHOICES.includes(months)) { flash(req, 'Choose what the payment covers.'); return res.redirect(back); }
    const church = b.churchId ? await rawDb.church.findUnique({ where: { id: String(b.churchId) }, select: { id: true, name: true, slug: true, plan: true, proUntil: true, proSince: true, deletedAt: true } }) : null;
    if (!church || church.deletedAt) { flash(req, 'Choose the church that paid.'); return res.redirect(back); }
    const method = Object.hasOwn(METHODS, b.method) ? b.method : 'OTHER';
    const operator = res.locals.operator;

    const payment = await rawDb.platformPayment.create({ data: {
      payerChurchId: church.id, churchName: church.name, amount: amount.toFixed(2), method,
      reference: String(b.reference || '').trim().slice(0, 100) || null,
      months: months || null, paidOn, note: String(b.note || '').trim().slice(0, 300) || null,
      recordedBy: operator.email,
    } });
    let extended = null;
    if (months && b.extend) {
      extended = extendedUntil(church.plan === 'pro' ? church.proUntil : null, months);
      await rawDb.church.update({ where: { id: church.id }, data: { plan: 'pro', proUntil: extended, proSince: church.plan === 'pro' && church.proSince ? church.proSince : new Date() } });
    }
    const subject = `${church.name} (${church.slug}) paid ${ghs(amount)} by ${METHODS[method]}${payment.reference ? ` (${payment.reference})` : ''}${extended ? `; Pro until ${isoDate(extended)}` : ''}`;
    await rawDb.securityAuditLog.create({ data: { churchId: church.id, actorId: null, event: 'platform.payment_recorded', subject, ip: requestIp(req), userAgent: requestUserAgent(req) } });
    await logPlatformEvent(req, { operator, event: 'platform.payment_recorded', subject, churchId: church.id });
    flash(req, `Recorded ${ghs(amount)} from ${church.name}.${extended ? ` Pro now runs until ${isoDate(extended)}.` : ''}`, 'success');
    res.redirect('/platform/payments');
  }));

  // For a payment entered by mistake. The church's plan is left as it is.
  app.post('/platform/payments/:id/delete', requireOperator, asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const payment = Number.isInteger(id) ? await rawDb.platformPayment.findUnique({ where: { id } }) : null;
    if (!payment) { flash(req, 'Payment not found.'); return res.redirect('/platform/payments'); }
    await rawDb.platformPayment.delete({ where: { id } });
    const subject = `Deleted payment: ${payment.churchName}, ${ghs(payment.amount)} on ${isoDate(payment.paidOn)}`;
    await logPlatformEvent(req, { operator: res.locals.operator, event: 'platform.payment_deleted', subject, churchId: payment.payerChurchId });
    flash(req, 'Payment record deleted. The church\'s plan was not changed.', 'success');
    res.redirect('/platform/payments');
  }));
}

module.exports = { register, revenueSummary };
