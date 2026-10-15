'use strict';
// Platform › SMS: the SMS account's balance, checked hourly with an alert to
// the operators when it falls below the level set here (lib/sms-balance.js),
// and each church's texts per month against its allowance (lib/sms-usage.js).

const asyncHandler = require('../lib/async-handler');
const { esc } = require('../lib/format');
const { pageHero, listCard, table } = require('../lib/views');
const { flash } = require('../lib/tenant-flash');
const { operatorLayout } = require('../lib/operator-shell');
const { requireOperator, logPlatformEvent } = require('../lib/platform-operators');
const { smsDeliveryInfo } = require('../lib/delivery');
const { checkSmsBalance, balanceState, balanceThreshold, setSetting, THRESHOLD_KEY } = require('../lib/sms-balance');
const { usageReport, monthOf } = require('../lib/sms-usage');
const { db: rawDb } = require('../lib/tenant');
const { PLAN_LIMITS } = require('../lib/plan');

function page(res, opts) {
  return res.send(operatorLayout({ ...opts, operator: res.locals.operator, flash: res.locals.flash, flashType: res.locals.flashType }));
}
const when = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC' : 'never');

async function balanceCard() {
  const [state, threshold] = await Promise.all([balanceState(), balanceThreshold()]);
  const info = smsDeliveryInfo();
  const balance = state && state.balance !== null && state.balance !== undefined ? Number(state.balance) : null;
  const low = balance !== null && balance < threshold;
  const channels = [
    (process.env.ALERT_EMAIL || process.env.PLATFORM_ADMIN_EMAILS) && 'email',
    process.env.ALERT_WEBHOOK_URL && 'webhook',
    process.env.SENTRY_DSN && 'Sentry',
    process.env.ALERT_PHONE && `text to ${process.env.ALERT_PHONE}`,
  ].filter(Boolean);
  return `
    <section class="card op-balance${low ? ' is-low' : ''}" id="balance">
      <div class="card-head"><h2>SMS balance</h2><span class="meta">${esc(info.label)} <span class="pill pill-${info.ready ? 'sent' : 'dry_run'}">${info.ready ? 'ready' : 'not configured'}</span></span></div>
      <p class="op-balance-figure"><strong>${balance === null ? '—' : esc(balance.toLocaleString('en-GB'))}</strong>${low ? ' <span class="pill pill-failed">below alert level</span>' : ''}</p>
      <p class="muted-text">Last checked ${esc(when(state && state.checkedAt))}${state && state.balanceAt && state.balanceAt !== state.checkedAt ? `; figure from ${esc(when(state.balanceAt))}` : ''}. Checked every hour.</p>
      ${state && state.error ? `<p class="error">The last check failed: ${esc(state.error)}</p>` : ''}
      <form method="post" action="/platform/sms/check" class="inline platform-inline-form"><button type="submit">Check now</button></form>
      <form method="post" action="/platform/sms/threshold" class="filter-bar" style="margin-top:0.8rem">
        <label>Alert me below <input type="number" name="threshold" min="0" step="1" value="${esc(String(threshold))}" style="width:110px"></label>
        <button type="submit" class="ghost">Save</button>
      </form>
      <p class="muted-text">Alerts go by ${channels.length ? esc(channels.join(', ')) : 'nothing yet: set ALERT_EMAIL (and ALERT_PHONE for a text)'}, once and then daily while it stays low.</p>
      ${state && state.raw ? `<details><summary>The provider's last reply</summary><pre class="op-raw">${esc(state.raw)}</pre></details>` : ''}
    </section>`;
}

async function usageCard(month) {
  const rows = await usageReport(month);
  const used = rows.filter((r) => r.messages);
  const totals = used.reduce((t, r) => ({ messages: t.messages + r.messages, segments: t.segments + r.segments }), { messages: 0, segments: 0 });
  const months = [];
  for (let i = 0; i < 12; i++) { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - i); months.push(monthOf(d)); }
  const label = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const tableRows = rows.map((r) => {
    const pct = r.allowance ? Math.min(100, Math.round((r.messages / r.allowance) * 100)) : (r.messages ? 100 : 0);
    return [
      `<a class="platform-church-link" href="/platform/churches/${esc(r.id)}"><strong>${esc(r.name)}</strong><small>${esc(r.slug)}</small></a>`,
      `<strong>${r.messages.toLocaleString('en-GB')}</strong><small>${r.segments.toLocaleString('en-GB')} pages</small>`,
      `<span class="op-meter${pct >= 100 ? ' full' : pct >= 90 ? ' near' : ''}" title="${pct}%"><span style="width:${pct}%"></span></span><small>${pct}% of ${r.allowance.toLocaleString('en-GB')}</small>`,
      `<form method="post" action="/platform/churches/${esc(r.id)}/sms-allowance" class="inline platform-inline-form">
        <input type="number" name="allowance" min="0" step="1" value="${r.custom ? r.allowance : ''}" placeholder="${(r.plan === 'pro' ? PLAN_LIMITS.pro : PLAN_LIMITS.free).smsPerMonth} (plan)" aria-label="Monthly allowance for ${esc(r.name)}" style="width:110px">
        <button type="submit" class="ghost">Set</button>
      </form>`,
    ];
  });
  return `
    <form method="get" action="/platform/sms" class="filter-bar" id="usage">
      <label>Month <select name="month" onchange="this.form.submit()">${months.map((m) => `<option value="${m}"${m === month ? ' selected' : ''}>${esc(label(m))}</option>`).join('')}</select></label>
      <noscript><button type="submit">Show</button></noscript>
    </form>
    ${listCard({
      title: `Texts in ${label(month)}`, count: totals.messages, countLabel: 'texts',
      note: `${totals.segments.toLocaleString('en-GB')} pages from ${used.length} church${used.length === 1 ? '' : 'es'}. Allowances: Free ${PLAN_LIMITS.free.smsPerMonth}, Pro ${PLAN_LIMITS.pro.smsPerMonth} a month; set a church's own, or clear it for its plan's.`,
      inner: table(['Church', 'Sent', 'Of allowance', 'Monthly allowance'], tableRows, { keyCols: 2 }),
    })}`;
}

function register(app) {
  app.get('/platform/sms', requireOperator, asyncHandler(async (req, res) => {
    const body = `
      ${pageHero('SMS', 'Your SMS account, and what each church sends.')}
      ${await balanceCard()}
      ${await usageCard(/^\d{4}-\d{2}$/.test(String(req.query.month || '')) ? String(req.query.month) : monthOf())}`;
    page(res, { title: 'SMS', active: '/platform/sms', body });
  }));

  app.post('/platform/sms/check', requireOperator, asyncHandler(async (req, res) => {
    const { alertOperators } = require('../lib/operations-scheduler');
    const r = await checkSmsBalance({ alert: alertOperators });
    if (r.skipped) flash(req, `Not checked: ${r.error}`, 'info');
    else if (r.ok) flash(req, `Balance: ${r.balance.toLocaleString('en-GB')}.${r.alerted ? ' It is below the alert level, so the alert was sent.' : ''}`, 'success');
    else flash(req, `The balance could not be read: ${r.error}`);
    res.redirect('/platform/sms#balance');
  }));

  // A church's own monthly allowance; empty goes back to its plan's.
  app.post('/platform/churches/:id/sms-allowance', requireOperator, asyncHandler(async (req, res) => {
    const raw = String((req.body && req.body.allowance) || '').trim();
    const n = raw === '' ? null : Number(raw);
    if (n !== null && (!Number.isInteger(n) || n < 0 || n > 10_000_000)) { flash(req, 'Enter a whole number, 0 or more, or leave it empty for the plan\'s.'); return res.redirect('/platform/sms#usage'); }
    const church = await rawDb.church.findUnique({ where: { id: req.params.id }, select: { id: true, name: true, slug: true } });
    if (!church) { flash(req, 'Church not found.'); return res.redirect('/platform/sms#usage'); }
    await rawDb.church.update({ where: { id: church.id }, data: { smsMonthlyAllowance: n } });
    const subject = `${church.name} (${church.slug}): SMS allowance ${n === null ? 'back to the plan\'s' : `${n} a month`}`;
    await logPlatformEvent(req, { operator: res.locals.operator, event: 'platform.sms_allowance', subject, churchId: church.id });
    flash(req, n === null ? `${church.name} is back on its plan's allowance.` : `${church.name} may now send ${n.toLocaleString('en-GB')} texts a month.`, 'success');
    res.redirect('/platform/sms#usage');
  }));

  app.post('/platform/sms/threshold', requireOperator, asyncHandler(async (req, res) => {
    const n = Number(req.body && req.body.threshold);
    if (!Number.isInteger(n) || n < 0 || n > 10_000_000) { flash(req, 'Enter a whole number, 0 or more.'); return res.redirect('/platform/sms#balance'); }
    await setSetting(THRESHOLD_KEY, n);
    await logPlatformEvent(req, { operator: res.locals.operator, event: 'platform.sms_alert_level', subject: `SMS balance alert level set to ${n}` });
    flash(req, `You'll be alerted when the balance falls below ${n.toLocaleString('en-GB')}.`, 'success');
    res.redirect('/platform/sms#balance');
  }));
}

module.exports = { register, balanceCard };
