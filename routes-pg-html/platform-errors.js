'use strict';
// Platform › Errors: the last 90 days of the error log, grouped
// (lib/error-groups.js), newest first, with "Mark fixed" per group.

const asyncHandler = require('../lib/async-handler');
const { esc } = require('../lib/format');
const { pageHero } = require('../lib/views');
const { flash } = require('../lib/tenant-flash');
const { operatorLayout } = require('../lib/operator-shell');
const { requireOperator, logPlatformEvent } = require('../lib/platform-operators');
const { errorGroups, resolveGroup } = require('../lib/error-groups');

function page(res, opts) {
  return res.send(operatorLayout({ ...opts, operator: res.locals.operator, flash: res.locals.flash, flashType: res.locals.flashType }));
}
const when = (d) => (d ? new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) : '');

function groupCard(g, show) {
  const s = g.sample;
  return `
    <article class="card op-error">
      <div class="card-head">
        <h2>${esc(g.message || '(no message)')}${g.cameBack ? ' <span class="pill pill-failed">came back</span>' : ''}</h2>
        <span class="meta"><strong>${show === 'fixed' ? g.fixed : g.open}×</strong></span>
      </div>
      <p><code>${esc(`${g.method || ''} ${g.path || ''}`.trim() || '—')}</code> · first ${esc(when(g.first))} · last ${esc(when(g.last))} · ${g.churches} church${g.churches === 1 ? '' : 'es'}${g.resolvedAt ? ` · marked fixed ${esc(when(g.resolvedAt))}${g.resolvedBy ? ` by ${esc(g.resolvedBy)}` : ''}` : ''}</p>
      <details><summary>Latest occurrence</summary>
        <p><code>${esc(`${s.method || ''} ${s.path || ''}`)}</code> · ${esc(when(s.occurredAt))}${s.churchId ? ` · <a href="/platform/churches/${esc(s.churchId)}">church</a>` : ''}</p>
        <p>${esc(s.message || '')}</p>
        ${s.stack ? `<pre class="op-raw">${esc(String(s.stack).slice(0, 4000))}</pre>` : ''}
      </details>
      ${show === 'open' ? `<form method="post" action="/platform/errors/resolve" class="inline platform-inline-form"><input type="hidden" name="key" value="${esc(g.key)}"><button type="submit" class="ghost">Mark fixed</button></form>` : ''}
    </article>`;
}

function register(app) {
  app.get('/platform/errors', requireOperator, asyncHandler(async (req, res) => {
    const show = req.query.show === 'fixed' ? 'fixed' : 'open';
    const [groups, other] = await Promise.all([errorGroups({ show }), errorGroups({ show: show === 'open' ? 'fixed' : 'open' })]);
    const counts = { open: show === 'open' ? groups.length : other.length, fixed: show === 'fixed' ? groups.length : other.length };
    const tabs = `<nav class="pm-tabs" aria-label="Errors">${[['open', 'Open'], ['fixed', 'Fixed']].map(([v, l]) => `<a href="/platform/errors${v === 'fixed' ? '?show=fixed' : ''}"${v === show ? ' aria-current="page"' : ''}>${l}<span>${counts[v]}</span></a>`).join('')}</nav>`;
    const body = `
      ${pageHero('Errors', 'The last 90 days of server errors, grouped: the same fault on different pages or records is one line.')}
      ${tabs}
      ${groups.length ? groups.map((g) => groupCard(g, show)).join('') : `<section class="card"><p class="muted-text">${show === 'open' ? 'No open errors.' : 'Nothing marked fixed yet.'}</p></section>`}`;
    page(res, { title: 'Errors', active: '/platform/errors', body });
  }));

  app.post('/platform/errors/resolve', requireOperator, asyncHandler(async (req, res) => {
    const key = String((req.body && req.body.key) || '');
    const n = key ? await resolveGroup(key, res.locals.operator.email) : 0;
    if (n) await logPlatformEvent(req, { operator: res.locals.operator, event: 'platform.errors_resolved', subject: `${n} × ${key.slice(0, 200)}` });
    flash(req, n ? `Marked ${n} error${n === 1 ? '' : 's'} fixed. If it happens again it comes back here.` : 'Nothing left to mark: it may already be fixed.', n ? 'success' : 'info');
    res.redirect('/platform/errors');
  }));
}

module.exports = { register };
