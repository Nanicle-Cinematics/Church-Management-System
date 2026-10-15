'use strict';
// Platform › SMS: the SMS account's balance, checked hourly with an alert to
// the operators when it falls below the level set here (lib/sms-balance.js).

const asyncHandler = require('../lib/async-handler');
const { esc } = require('../lib/format');
const { pageHero } = require('../lib/views');
const { flash } = require('../lib/tenant-flash');
const { operatorLayout } = require('../lib/operator-shell');
const { requireOperator, logPlatformEvent } = require('../lib/platform-operators');
const { smsDeliveryInfo } = require('../lib/delivery');
const { checkSmsBalance, balanceState, balanceThreshold, setSetting, THRESHOLD_KEY } = require('../lib/sms-balance');

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

function register(app) {
  app.get('/platform/sms', requireOperator, asyncHandler(async (req, res) => {
    const body = `
      ${pageHero('SMS', 'Your SMS account: balance and alerts.')}
      ${await balanceCard()}`;
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
