'use strict';
// Platform › Operators: the console's own accounts, managed here instead of
// only with scripts/platform-operator.js on the server (which still works).
// Add an operator, reset their password or two-factor, rename, disable or
// enable them, and change your own password.
//
// A new or reset password is random and shown once, on the page that made
// it: never put in a flash message, which would sit in the session store.
// Nobody can disable themselves, and the last enabled operator cannot be
// disabled. Each change is in the platform audit log.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const asyncHandler = require('../lib/async-handler');
const { esc } = require('../lib/format');
const { pageHero, listCard, table } = require('../lib/views');
const { flash } = require('../lib/tenant-flash');
const { db: rawDb } = require('../lib/tenant');
const { operatorLayout } = require('../lib/operator-shell');
const { requireOperator, logPlatformEvent, revokeOperatorSessions, hashOperatorPassword, normEmail } = require('../lib/platform-operators');

function page(res, opts) {
  return res.send(operatorLayout({ ...opts, operator: res.locals.operator, flash: res.locals.flash, flashType: res.locals.flashType }));
}
const when = (d) => (d ? new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) : 'never');
const cleanName = (raw) => String(raw || '').trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim().slice(0, 80) || null;
const newPassword = () => crypto.randomBytes(18).toString('base64url');

// The once-only page showing a new password.
function passwordPage(res, { title, who, password, note }) {
  page(res, {
    title, active: '/platform/operators',
    body: `${pageHero(title, '')}
      <section class="card">
        <p>The password for <strong>${esc(who)}</strong> is:</p>
        <p class="op-secret"><code>${esc(password)}</code></p>
        <p>Copy it now and give it to them privately. It is not shown again. ${esc(note)}</p>
        <p><a class="btn" href="/platform/operators">Done</a></p>
      </section>`,
  });
}

function register(app) {
  app.get('/platform/operators', requireOperator, asyncHandler(async (req, res) => {
    const me = res.locals.operator;
    const operators = await rawDb.platformOperator.findMany({ orderBy: { createdAt: 'asc' } });
    const rows = operators.map((o) => {
      const locked = o.lockedUntil && new Date(o.lockedUntil) > new Date();
      const state = o.disabledAt ? '<span class="pill pill-failed">disabled</span>'
        : `${o.totpEnabled ? '<span class="pill pill-sent">2FA on</span>' : '<span class="pill pill-pending">2FA at next sign-in</span>'}${locked ? ' <span class="pill pill-failed">locked</span>' : ''}`;
      const act = (action, label, cls = 'ghost', confirmText = '') => `<form method="post" action="/platform/operators/${o.id}/${action}" class="inline platform-inline-form"${confirmText ? ` onsubmit="return confirm('${esc(confirmText)}')"` : ''}><button type="submit" class="${cls}">${label}</button></form>`;
      const self = o.id === me.id;
      return [
        `<strong>${esc(o.displayName || o.email)}</strong><small>${esc(o.email)}${self ? ' · you' : ''}</small>`,
        state,
        esc(when(o.lastLoginAt)),
        `<div class="platform-actions">
          ${self ? '' : act('reset-password', 'Reset password', 'ghost', 'Give them a new password? They will be signed out everywhere.')}
          ${self ? '' : act('reset-2fa', 'Reset two-factor', 'ghost', 'Clear their two-factor? They set it up again at their next sign-in.')}
          ${self ? '' : o.disabledAt ? act('enable', 'Enable') : act('disable', 'Disable', 'danger', 'Disable this operator? They are signed out at once.')}
          <form method="post" action="/platform/operators/${o.id}/rename" class="inline platform-inline-form"><input name="displayName" value="${esc(o.displayName || '')}" placeholder="Name" aria-label="Name" style="width:140px"><button type="submit" class="ghost">Rename</button></form>
        </div>`,
      ];
    });
    const body = `
      ${pageHero('Operators', 'The people who can sign in to this console. Everyone must use two-factor.')}
      ${listCard({ title: 'Operators', count: operators.length, countLabel: operators.length === 1 ? 'operator' : 'operators', inner: table(['Operator', 'State', 'Last sign-in', ''], rows, { keyCols: 2 }) })}
      <section class="card">
        <div class="card-head"><h2>Add an operator</h2></div>
        <form class="form" method="post" action="/platform/operators">
          <label>Email<input type="email" name="email" required></label>
          <label>Name<input name="displayName" maxlength="80"></label>
          <div class="actions"><button type="submit">Add operator</button></div>
        </form>
        <p class="muted-text">They get a password shown once on the next page, and set up two-factor at their first sign-in at /platform/login.</p>
      </section>
      <section class="card">
        <div class="card-head"><h2>Change my password</h2></div>
        <form class="form" method="post" action="/platform/operators/me/password">
          <label>Current password<input type="password" name="current" required autocomplete="current-password"></label>
          <label>New password<input type="password" name="password" required minlength="12" autocomplete="new-password"><span class="hint">At least 12 characters.</span></label>
          <div class="actions"><button type="submit">Change password</button></div>
        </form>
      </section>`;
    page(res, { title: 'Operators', active: '/platform/operators', body });
  }));

  app.post('/platform/operators', requireOperator, asyncHandler(async (req, res) => {
    const email = normEmail(req.body && req.body.email);
    if (!/^\S+@\S+\.\S+$/.test(email)) { flash(req, 'Enter their email.'); return res.redirect('/platform/operators'); }
    if (await rawDb.platformOperator.findUnique({ where: { email } })) { flash(req, `${email} is already an operator.`); return res.redirect('/platform/operators'); }
    const password = newPassword();
    const created = await rawDb.platformOperator.create({ data: { email, displayName: cleanName(req.body.displayName), passwordHash: await hashOperatorPassword(password) } });
    await logPlatformEvent(req, { operator: res.locals.operator, event: 'operator.created', subject: email });
    passwordPage(res, { title: 'Operator added', who: created.email, password, note: 'They sign in at /platform/login and set up two-factor there.' });
  }));

  app.post('/platform/operators/me/password', requireOperator, asyncHandler(async (req, res) => {
    const me = await rawDb.platformOperator.findUnique({ where: { id: res.locals.operator.id } });
    const { current, password } = req.body || {};
    if (!me || !(await bcrypt.compare(String(current || ''), me.passwordHash))) { flash(req, 'Your current password is not right.'); return res.redirect('/platform/operators'); }
    let passwordHash;
    try { passwordHash = await hashOperatorPassword(String(password || '')); } catch (e) { flash(req, e.message); return res.redirect('/platform/operators'); }
    await rawDb.platformOperator.update({ where: { id: me.id }, data: { passwordHash } });
    await logPlatformEvent(req, { operator: res.locals.operator, event: 'operator.password_changed', subject: me.email });
    flash(req, 'Your password is changed.', 'success');
    res.redirect('/platform/operators');
  }));

  const target = (action, handler) => app.post(`/platform/operators/:id/${action}`, requireOperator, asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const o = Number.isInteger(id) ? await rawDb.platformOperator.findUnique({ where: { id } }) : null;
    if (!o) { flash(req, 'Operator not found.'); return res.redirect('/platform/operators'); }
    return handler(req, res, o, o.id === res.locals.operator.id);
  }));

  target('reset-password', async (req, res, o, self) => {
    if (self) { flash(req, 'Use Change my password for your own.'); return res.redirect('/platform/operators'); }
    const password = newPassword();
    await rawDb.platformOperator.update({ where: { id: o.id }, data: { passwordHash: await hashOperatorPassword(password), failedAttempts: 0, lockedUntil: null } });
    await revokeOperatorSessions(o.id);
    await logPlatformEvent(req, { operator: res.locals.operator, event: 'operator.password_reset', subject: o.email });
    passwordPage(res, { title: 'Password reset', who: o.email, password, note: 'They have been signed out everywhere.' });
  });

  target('reset-2fa', async (req, res, o, self) => {
    if (self) { flash(req, 'Ask another operator to reset your two-factor.'); return res.redirect('/platform/operators'); }
    await rawDb.platformOperator.update({ where: { id: o.id }, data: { totpEnabled: false, totpSecret: null, totpRecoveryCodes: null } });
    await revokeOperatorSessions(o.id);
    await logPlatformEvent(req, { operator: res.locals.operator, event: 'operator.mfa_reset', subject: o.email });
    flash(req, `Two-factor cleared for ${o.email}. They set it up again at their next sign-in.`, 'success');
    res.redirect('/platform/operators');
  });

  target('disable', async (req, res, o, self) => {
    if (self) { flash(req, 'You cannot disable yourself.'); return res.redirect('/platform/operators'); }
    const others = await rawDb.platformOperator.count({ where: { disabledAt: null, id: { not: o.id } } });
    if (!others) { flash(req, 'This is the last enabled operator.'); return res.redirect('/platform/operators'); }
    await rawDb.platformOperator.update({ where: { id: o.id }, data: { disabledAt: new Date() } });
    await revokeOperatorSessions(o.id);
    await logPlatformEvent(req, { operator: res.locals.operator, event: 'operator.disabled', subject: o.email });
    flash(req, `${o.email} is disabled and signed out everywhere.`, 'success');
    res.redirect('/platform/operators');
  });

  target('enable', async (req, res, o) => {
    await rawDb.platformOperator.update({ where: { id: o.id }, data: { disabledAt: null, failedAttempts: 0, lockedUntil: null } });
    await logPlatformEvent(req, { operator: res.locals.operator, event: 'operator.enabled', subject: o.email });
    flash(req, `${o.email} is enabled again.`, 'success');
    res.redirect('/platform/operators');
  });

  target('rename', async (req, res, o) => {
    const displayName = cleanName(req.body && req.body.displayName);
    await rawDb.platformOperator.update({ where: { id: o.id }, data: { displayName } });
    await logPlatformEvent(req, { operator: res.locals.operator, event: 'operator.renamed', subject: `${o.email}: ${displayName || '(no name)'}` });
    flash(req, `${o.email} is now shown as ${displayName ? `"${displayName}"` : 'their email'}.`, 'success');
    res.redirect('/platform/operators');
  });
}

module.exports = { register };
