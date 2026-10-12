'use strict';
// Platform console sign-in (see lib/platform-operators.js). Separate from the
// church /login: password, then two-factor. An operator who has never set up
// two-factor is walked through it right after the password and cannot reach
// the console until it is done.

const QRCode = require('qrcode');
const asyncHandler = require('../lib/async-handler');
const { esc } = require('../lib/format');
const { db } = require('../lib/tenant');
const { createRateLimiter } = require('../lib/rate-limit');
const { createTotpSecret, verifyTotp, createRecoveryCodes, consumeRecoveryCode } = require('../lib/mfa');
const { operatorAuthPage } = require('../lib/operator-shell');
const {
  authenticateOperator, startPendingOperator, pendingOperatorId, createOperatorSession,
  logPlatformEvent,
} = require('../lib/platform-operators');

const loginLimit = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  key: (req) => `op|${req.ip}|${String(req.body?.email || '').trim().toLowerCase()}`,
});
const codeLimit = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  key: (req) => `op-mfa|${req.ip}|${req.session?.pendingOperatorId || 'none'}`,
});

function loginBody({ error, email } = {}) {
  return `
    <form class="form auth-form" method="post" action="/platform/login">
      ${error ? `<p class="error">${esc(error)}</p>` : ''}
      <label class="wide">Email<input type="email" name="email" required autofocus autocomplete="username" value="${esc(email || '')}"></label>
      <label class="wide">Password<input type="password" name="password" required autocomplete="current-password"></label>
      <div class="actions"><button type="submit">Continue</button></div>
      <p class="auth-aux">For platform operators only. Church staff sign in at <a href="/login">/login</a>.</p>
    </form>`;
}

function codeBody({ error } = {}) {
  return `
    <p class="muted">Enter the six-digit code from your authenticator app, or one of your recovery codes.</p>
    <form class="form auth-form" method="post" action="/platform/login/mfa">
      ${error ? `<p class="error">${esc(error)}</p>` : ''}
      <label class="wide">Verification code<input name="code" required autofocus autocomplete="one-time-code"></label>
      <div class="actions"><button type="submit">Verify</button></div>
    </form>`;
}

async function setupBody(req, { error } = {}) {
  const qr = await QRCode.toDataURL(req.session.operatorSetupUri, { width: 200, margin: 1 });
  return `
    <p class="muted">Two-factor sign-in is required for the platform console. Scan this code with an authenticator app (Google Authenticator, 1Password, Authy…), then enter the six-digit code it shows.</p>
    <img class="op-qr" src="${esc(qr)}" alt="Authenticator setup QR code" width="200" height="200">
    <details><summary>Can't scan? Enter this key instead</summary><code class="op-key">${esc(req.session.operatorSetupSecret)}</code></details>
    <form class="form auth-form" method="post" action="/platform/setup-2fa">
      ${error ? `<p class="error">${esc(error)}</p>` : ''}
      <label class="wide">Six-digit code<input name="code" required inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}"></label>
      <div class="actions"><button type="submit">Turn on two-factor</button></div>
    </form>`;
}

// The pending (password-checked) operator, or null when the step expired.
async function pendingOperator(req) {
  const id = pendingOperatorId(req);
  if (!id) return null;
  const operator = await db.platformOperator.findUnique({ where: { id } });
  return operator && !operator.disabledAt ? operator : null;
}

async function finishSignIn(req, res, operator, event) {
  await createOperatorSession(req, operator.id);
  await db.platformOperator.update({ where: { id: operator.id }, data: { lastLoginAt: new Date() } });
  await logPlatformEvent(req, { operator, event, subject: operator.email });
}

function register(app) {
  app.get('/platform/login', (req, res) => {
    if (res.locals.operator) return res.redirect('/platform');
    res.send(operatorAuthPage('Sign in', loginBody()));
  });

  app.post('/platform/login', loginLimit, asyncHandler(async (req, res) => {
    const { email, password } = req.body || {};
    const result = await authenticateOperator(email, password);
    if (result.status === 'locked') {
      if (result.operator) await logPlatformEvent(req, { operator: result.operator, event: 'operator.login_locked', subject: result.operator.email });
      const mins = Math.max(1, Math.ceil((result.until.getTime() - Date.now()) / 60000));
      return res.status(423).send(operatorAuthPage('Sign in', loginBody({ error: `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`, email })));
    }
    if (result.status !== 'ok') {
      if (result.operator) await logPlatformEvent(req, { operator: result.operator, event: 'operator.login_failed', subject: result.operator.email });
      return res.status(401).send(operatorAuthPage('Sign in', loginBody({ error: 'Incorrect email or password.', email })));
    }
    await startPendingOperator(req, result.operator.id);
    if (result.operator.totpEnabled && result.operator.totpSecret) return res.redirect('/platform/login/mfa');
    const { secret, uri } = createTotpSecret(`Platform · ${result.operator.email}`);
    req.session.operatorSetupSecret = secret;
    req.session.operatorSetupUri = uri;
    return res.redirect('/platform/setup-2fa');
  }));

  app.get('/platform/login/mfa', asyncHandler(async (req, res) => {
    const operator = await pendingOperator(req);
    if (!operator || !operator.totpEnabled) return res.redirect('/platform/login');
    res.send(operatorAuthPage('Two-factor check', codeBody()));
  }));

  app.post('/platform/login/mfa', codeLimit, asyncHandler(async (req, res) => {
    const operator = await pendingOperator(req);
    if (!operator || !operator.totpEnabled || !operator.totpSecret) return res.redirect('/platform/login');
    const code = String(req.body?.code || '').trim();
    const validTotp = verifyTotp(operator.totpSecret, code);
    const remaining = validTotp ? null : consumeRecoveryCode(operator.totpRecoveryCodes, code);
    if (!validTotp && remaining === null) {
      await logPlatformEvent(req, { operator, event: 'operator.mfa_failed', subject: operator.email });
      return res.status(401).send(operatorAuthPage('Two-factor check', codeBody({ error: 'Incorrect verification code.' })));
    }
    if (remaining !== null) {
      await db.platformOperator.update({ where: { id: operator.id }, data: { totpRecoveryCodes: remaining } });
    }
    await finishSignIn(req, res, operator, remaining !== null ? 'operator.login_recovery_code' : 'operator.login');
    return res.redirect('/platform');
  }));

  app.get('/platform/setup-2fa', asyncHandler(async (req, res) => {
    const operator = await pendingOperator(req);
    if (!operator || operator.totpEnabled || !req.session.operatorSetupSecret) return res.redirect('/platform/login');
    res.send(operatorAuthPage('Set up two-factor', await setupBody(req)));
  }));

  app.post('/platform/setup-2fa', codeLimit, asyncHandler(async (req, res) => {
    const operator = await pendingOperator(req);
    const secret = req.session.operatorSetupSecret;
    if (!operator || operator.totpEnabled || !secret) return res.redirect('/platform/login');
    if (!verifyTotp(secret, req.body?.code)) {
      return res.status(400).send(operatorAuthPage('Set up two-factor', await setupBody(req, { error: 'That code did not match. Check the time on your phone and try the newest code.' })));
    }
    const recovery = createRecoveryCodes();
    // Only claim setup if no one finished it in another tab meanwhile.
    const claimed = await db.platformOperator.updateMany({
      where: { id: operator.id, totpEnabled: false },
      data: { totpEnabled: true, totpSecret: secret, totpRecoveryCodes: recovery.serialized },
    });
    if (claimed.count !== 1) return res.redirect('/platform/login');
    await logPlatformEvent(req, { operator, event: 'operator.mfa_enabled', subject: operator.email });
    await finishSignIn(req, res, operator, 'operator.login');
    res.send(operatorAuthPage('Save your recovery codes', `
      <p class="muted">If you lose your phone, each of these codes signs you in once. Keep them somewhere safe, such as a password manager. They will not be shown again.</p>
      <div class="op-codes">${recovery.codes.map((c) => `<span>${esc(c)}</span>`).join('')}</div>
      <p><a class="pu-btn" href="/platform">I've saved them, continue</a></p>`));
  }));

  app.post('/platform/logout', (req, res) => {
    const operator = res.locals.operator;
    if (operator) void logPlatformEvent(req, { operator, event: 'operator.logout', subject: operator.email });
    req.session.destroy(() => {
      res.clearCookie('connect.sid');
      res.redirect('/platform/login');
    });
  });
}

module.exports = { register };
