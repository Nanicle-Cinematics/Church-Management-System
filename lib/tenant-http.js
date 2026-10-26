'use strict';
// Express app wiring the Postgres-backed auth/signup/session subsystem
// (lib/auth.js + lib/provision.js + lib/tenant.js + lib/async-handler.js)
// AND, as of Phase 8, the HTML view layer (lib/tenant-shell.js/tenant-csrf.js
// /tenant-flash.js, routes-pg-html/*.js) — one app, so session/CSRF/auth
// resolution is identical for JSON and HTML requests. NOT wired into the
// live production server.js; see the Phase 8 plan for the eventual cutover.

const path = require('path');
const Sentry = require('@sentry/node');
const express = require('express');
const compression = require('compression');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const asyncHandler = require('./async-handler');
const { getDatabaseUrl } = require('./database-url');
const { tenantDb, readOnlyTenantDb, db: rawDb } = require('./tenant');
const {
  authenticate, resolveSessionUser, createSession, createPendingMfaSession, destroySession,
  createEmailVerificationToken,
} = require('./auth');
const { signupChurch, SignupError } = require('./provision');
const { csrfIssue, csrfCheck, csrfField } = require('./tenant-csrf');
const { resolveSupportView, supportReadOnly, startSupportView, endSupportView } = require('./support-view');
const { flashRead } = require('./tenant-flash');
const { layout, authPage } = require('./tenant-shell');
const authRoutes = require('./tenant-auth-routes');
const { landingPage } = require('./tenant-landing');
const { renderDashboard } = require('./tenant-dashboard');
const { currentColour, promptEntry } = require('./liturgical');
const { promptHtml } = require('./almanac-ui');
const { welcomePage } = require('./welcome');
const { logSecurityEvent } = require('./security-audit');
const { isDatabaseUnavailableError } = require('./db-health');
const { maintenancePage } = require('./maintenance-page');
const { createRateLimiter } = require('./rate-limit');
const { redactUrl } = require('./redact-url');
const { verifyTotp, consumeRecoveryCode } = require('./mfa');
const { resolveSessionOperator } = require('./platform-operators');
const { loginLabel } = require('./phone');
const { blockLimitedAreas } = require('./access');
const { sendEmailEach } = require('./delivery');
const { esc } = require('./format');
const { emailLinkBase } = require('./public-url');
const { getSessionSecret } = require('./session-secret');

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// The page for a refusal (403) or a missing page (404), inside the app.
const ROLE_LABELS = { ADMIN: 'Administrator', EDITOR: 'Editor', VIEWER: 'Viewer' };
function problemPage(status, message, user, liturgical = null) {
  const role = ROLE_LABELS[user.role] || 'Viewer';
  const text = String(message || '').trim();
  const generic = !text || /^(forbidden|not found)$/i.test(text);
  const body = status === 403
    ? `<p>${generic ? `Your role (${esc(role)}) doesn’t include this.` : esc(text)}</p>
       <p>${user.role === 'ADMIN' ? 'Check the roles on <a href="/users">Users &amp; Roles</a>.' : 'If you need it, ask an administrator of your church to change your access on Users &amp; Roles.'}</p>`
    : `<p>${generic ? 'That page doesn’t exist, or it has moved.' : esc(text)}</p>`;
  return layout({
    title: status === 403 ? 'You don’t have access to this' : 'Page not found',
    active: null,
    user,
    liturgical,
    body: `${body}<p><a class="btn primary" href="/">Back to dashboard</a> <a class="btn ghost" href="/help">Help</a></p>`,
  });
}

function securityHeaders(req, res, next) {
  res.set({
    'Content-Security-Policy': [
      "default-src 'self'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "img-src 'self' data:",
      "object-src 'none'",
      // Scripts only from our own files (public/js/): no inline script tags,
      // no inline onclick-style handlers, no links that run script. An attacker
      // who gets markup into a page therefore cannot make it run code. Pages
      // ask for behaviour with data- attributes handled by public/js/ui.js.
      "script-src 'self'",
      // Styles stay inline: the app uses style="" attributes in many places,
      // and injected CSS is a far smaller risk than injected script.
      "style-src 'self' 'unsafe-inline'",
    ].join('; '),
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  });
  if (IS_PRODUCTION) {
    res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

const MAX_FIELD_LENGTH = 20000;
function hasOversizedString(value, depth) {
  if (typeof value === 'string') return value.length > MAX_FIELD_LENGTH;
  if (!value || typeof value !== 'object' || depth > 4) return false;
  return Object.values(value).some((v) => hasOversizedString(v, depth + 1));
}

function createTenantApp({ sessionSecret, pool, sessionTableName = 'session' } = {}) {
  const app = express();
  const loginRateLimit = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 20,
    key: (req) => `${req.ip}|${String(req.body?.email || req.body?.phone || req.body?.login || '').trim().toLowerCase()}`,
  });
  // The limiter above is per IP *and* email, so one IP trying a single common
  // password against every address in the system never fills any one bucket
  // (password spraying). This one counts every attempt from an IP, whichever
  // address it names. Generous enough for a church office sharing one IP.
  const loginIpRateLimit = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 100,
    key: (req) => `ip|${req.ip}`,
  });
  const signupRateLimit = createRateLimiter({
    windowMs: 60 * 60 * 1000,
    max: 30,
    key: (req) => req.ip,
  });
  const mfaRateLimit = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 10,
    key: (req) => `${req.ip}|${req.session?.pendingMfaUserId || 'none'}`,
  });
  app.disable('x-powered-by');
  if (IS_PRODUCTION) app.set('trust proxy', 1);
  app.use(securityHeaders);
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  // No free-text field in this app needs more than a few KB, but the body
  // limit allowed a single field of up to 1MB, which was then stored and
  // rendered on list pages. Refuse absurd field sizes up front.
  app.use((req, res, next) => {
    if (req.body && hasOversizedString(req.body, 0)) {
      const message = 'One of the fields is too long.';
      if (req.path.startsWith('/api/') || req.is('application/json')) return res.status(413).json({ error: message });
      return res.status(413).send(message);
    }
    next();
  });
  // Compression is applied to /static ONLY, deliberately — not to rendered
  // HTML. This app has the exact shape BREACH exploits: a stable per-session
  // CSRF token (lib/tenant-csrf.js issues one token and reuses it for the
  // session) sitting in the same response as attacker-influenceable reflected
  // input (search terms are echoed back into the filter form). Compressing
  // those together leaks token bytes through response size. Static assets
  // carry no secrets and no reflected input, so they compress safely — and
  // they are where essentially all the weight is: the stylesheets are ~260KB
  // uncompressed against a few KB of HTML per page.
  //
  // The edge proxy in front of this app does compress, but weakly — it was
  // serving styles.css at 60.8KB where gzip level 6 gives 42.4KB.
  app.use('/static', compression(), express.static(path.join(__dirname, '..', 'public'), {
    maxAge: IS_PRODUCTION ? '1d' : 0,
    immutable: false,
  }));

  // Device notifications (lib/push.js) and the offline page: the service
  // worker must be served from the site root to cover every page. The
  // manifest is per church, so it is served after the session is read
  // (routes-pg-html/settings.js).
  app.get('/sw.js', (req, res) => {
    res.set({ 'Service-Worker-Allowed': '/', 'Cache-Control': 'no-cache' });
    res.type('application/javascript').sendFile(path.join(__dirname, '..', 'public', 'sw.js'));
  });

  // Fly.io health checks (see fly.toml) — must not require session/auth.
  app.get('/healthz', (req, res) => {
    res.status(200).json({ status: 'ok' });
  });
  app.get('/readyz', asyncHandler(async (req, res) => {
    try {
      await rawDb.$queryRaw`SELECT 1 AS ok`;
      res.status(200).json({ status: 'ready', db: 'ok' });
    } catch (error) {
      res.status(503).json({ status: 'not-ready', db: 'error', error: 'database unavailable' });
    }
  }));

  const sessionStore = new pgSession({
    pool: pool || new Pool({ connectionString: getDatabaseUrl() }),
    tableName: sessionTableName,
    createTableIfMissing: false,
    pruneSessionInterval: false,
  });
  // For test/session-prune.test.js (routes can't be added after the 404 below).
  app.locals.sessionStore = sessionStore;
  app.use(session({
    // The table must already exist (run `node scripts/ensure-session-table.js`
    // once) — createTableIfMissing is deliberately off. connect-pg-simple
    // hardcodes its PK constraint name to "session_pkey" regardless of table
    // name, so concurrent auto-create attempts (e.g. two test files) race on
    // that literal schema-wide-unique name.
    //
    // pruneSessionInterval is OFF for the same reason fly.toml no longer polls
    // /readyz: the default is a DELETE every 15 minutes, forever, from the moment
    // the first session is touched. Neon suspends after 5 idle minutes, so that
    // one timer alone kept the compute awake a third of the month (measured:
    // 132 active hours in the first 16 days of September 2026, with no users).
    // Expired rows are harmless — get() already filters on expire — so they
    // are swept once a night by lib/operations-scheduler.js instead, while the
    // database is awake for the backup anyway. See pruneExpiredSessions().
    store: sessionStore,
    secret: sessionSecret || getSessionSecret(),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      secure: IS_PRODUCTION,
      sameSite: 'lax',
      maxAge: 8 * 60 * 60 * 1000,
    },
  }));

  // Attach res.locals.user/church/db for any authenticated request. A
  // platform operator's read-only support view (lib/support-view.js) takes
  // precedence: a stand-in admin of that church, over a read-only db.
  app.use(asyncHandler(async (req, res, next) => {
    const support = req.session && req.session.supportView ? await resolveSupportView(req) : null;
    const user = support || await resolveSessionUser(req);
    if (user) {
      res.locals.user = user;
      res.locals.churchId = user.churchId;
      res.locals.church = user.church;   // carries plan/proUntil for lib/plan.js
      res.locals.db = support ? readOnlyTenantDb(user.churchId) : tenantDb(user.churchId);
      if (support) res.locals.supportView = support.supportView;
      // The church's liturgical colour (lib/liturgical.js): one cached lookup, and a failure here must never stop a page.
      try { res.locals.liturgical = await currentColour(res.locals.db, user.churchId); } catch (_) { res.locals.liturgical = null; }
    }
    next();
  }));

  // One central suspension gate protects every tenant route. Platform owners
  // retain access to the operator console so they can reactivate a church.
  app.use((req, res, next) => {
    const user = res.locals.user;
    if (!user?.church?.suspendedAt && !user?.church?.deletedAt) return next();
    if (req.path === '/logout') return next();
    // The operator console has its own sign-in and accounts, so a browser
    // still holding a dead church's session can reach it (to restore that
    // church, for one).
    if (/^\/(api\/)?platform(\/|$)/.test(req.path)) return next();
    const message = user.church.deletedAt
      ? (user.church.deletionReason
        ? `This church has been deleted: ${user.church.deletionReason}`
        : 'This church has been deleted. Contact the platform owner if it should be restored.')
      : (user.church.suspensionReason
        ? `This church's access is suspended: ${user.church.suspensionReason}`
        : 'This church’s access is suspended. Contact the platform owner.');
    if (req.path.startsWith('/api/') || req.is('application/json')) {
      return res.status(403).json({ error: user.church.deletedAt ? 'church deleted' : 'church suspended', message });
    }
    return res.status(403).send(authPage('Access suspended',
      // This page is drawn before csrfIssue adds tokens to forms, so the
      // Sign out form carries its own. Without it the post was refused and
      // bounced back here, leaving the browser stuck on this screen.
      `<p class="error">${esc(message)}</p><form method="post" action="/logout">${csrfField(req)}<button type="submit">Sign out</button></form>`));
  });

  // Platform operators (lib/platform-operators.js) are a separate kind of
  // account with their own session key; only the console's paths look it up.
  app.use(asyncHandler(async (req, res, next) => {
    if (req.session?.operatorId && /^\/(api\/)?platform(\/|$)/.test(req.path)) {
      res.locals.operator = await resolveSessionOperator(req);
    }
    next();
  }));

  // Phase 8: HTML-layer middleware (CSRF issue+check, flash, res.page).
  // JSON API requests bypass CSRF (see lib/tenant-csrf.js) so none of the
  // existing routes-pg/*.js / test/*.test.js behavior changes.
  app.use(csrfIssue);
  app.use(csrfCheck);
  app.use(flashRead);
  app.use((req, res, next) => {
    res.page = (opts) => res.send(layout({
      ...opts,
      user: opts.user ?? res.locals.user,
      flash: opts.flash ?? res.locals.flash,
      flashType: opts.flashType ?? res.locals.flashType,
      liturgical: opts.liturgical ?? res.locals.liturgical,
      colourPrompt: opts.colourPrompt ?? res.locals.colourPrompt,
    }));
    next();
  });

  // An admin is offered this week's Almanac colour on every page until one is chosen
  // (lib/liturgical.js). Only while no colour is in force, so most requests cost nothing extra;
  // the Almanac page has its own controls. A failure here must never stop a page.
  app.use(asyncHandler(async (req, res, next) => {
    const u = res.locals.user;
    if (req.method === 'GET' && u && u.role === 'ADMIN' && !res.locals.liturgical && req.path !== '/almanac' && !req.path.startsWith('/api/')) {
      try {
        const entry = await promptEntry(res.locals.db, res.locals.churchId, u, req.session);
        if (entry) res.locals.colourPrompt = promptHtml(entry, req.originalUrl);
      } catch (_) { /* no prompt */ }
    }
    next();
  }));

  // Refusals and missing pages in the browser. Routes answer 403 and 404 with
  // a short sentence ('Forbidden', 'This area needs finance access…'), which
  // on its own is a bare white page with no way back. Signed-in people get it
  // inside the app instead, saying what happened and what they can do. JSON
  // and pages that send their own HTML are left alone.
  app.use((req, res, next) => {
    if (!res.locals.user || req.path.startsWith('/api/')) return next();
    const send = res.send.bind(res);
    res.send = (body) => {
      const plain = typeof body === 'string' && !body.includes('<') && !/json/.test(res.get('Content-Type') || '');
      if ((res.statusCode === 403 || res.statusCode === 404) && plain) {
        res.send = send;
        res.type('html');
        return send(problemPage(res.statusCode, body, res.locals.user, res.locals.liturgical));
      }
      return send(body);
    };
    next();
  });
  // A support view is read-only (lib/support-view.js); refusals are drawn
  // inside the app by the middleware above.
  app.use(supportReadOnly);

  function requireAuth(req, res, next) {
    if (!res.locals.user) return res.status(401).json({ error: 'not logged in' });
    next();
  }

  // Numeric ids only. A non-numeric :id used to reach Prisma as NaN and come
  // back as a 500 (with the validation text); answer 404 instead. The platform
  // console's :id is a string church id, so it is exempt.
  app.param(['id', 'memberId', 'lineId'], (req, res, next, value) => {
    if (/^\d+$/.test(value) || /^\/(api\/)?platform\//.test(req.path)) return next();
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
    return res.status(404).send('Not found');
  });

  // These three endpoints are shared by BOTH the JSON API surface (used by
  // every test/*.test.js file since Phase 1) and, as of Phase 8, real
  // HTML <form> submissions. They content-negotiate on the SAME signal
  // lib/tenant-csrf.js already uses (req.is('application/json')) rather than
  // duplicating separate HTML routes at the same paths, which Express could
  // never reach anyway (first-registered route wins) — existing JSON
  // behavior is completely unchanged for JSON requests.
  app.post('/signup', signupRateLimit, asyncHandler(async (req, res) => {
    const wantsJson = req.is('application/json');
    try {
      const { church, user } = await signupChurch(req.body || {});
      if (process.env.REQUIRE_EMAIL_VERIFICATION === '1') {
        const verification = await createEmailVerificationToken(user.id);
        const base = emailLinkBase(req);
        if (!base) console.error('[auth] PUBLIC_URL is not set; refusing to email a verification link built from the Host header.');
        const sent = base
          ? await sendEmailEach(tenantDb(church.id), [{ addr: user.email }],
            'Verify your Church Manager email',
            `Verify your email within 24 hours:\n\n${base}/verify-email/${verification.token}`, { churchName: church.name, withFooter: false })
          : { ok: false };
        if (wantsJson) return res.status(201).json({
          ok: true, verificationRequired: true, verificationEmailSent: sent.ok,
        });
        return res.send(authPage('Check your email', sent.ok
          ? '<p class="success">We sent you a verification link. It expires in 24 hours.</p>'
          : '<p class="error">Your church was created, but email delivery is temporarily unavailable. Contact support or resend verification from the login page.</p>'));
      }
      await createSession(req, user.id);
      if (wantsJson) {
        return res.status(201).json({ ok: true, church: { id: church.id, slug: church.slug }, user: { id: user.id, email: user.email } });
      }
      return res.redirect('/welcome');
    } catch (e) {
      if (e instanceof SignupError) {
        if (wantsJson) return res.status(400).json({ error: e.message });
        return authRoutes.renderSignupForm(req, res, { error: e.message, body: req.body });
      }
      throw e;
    }
  }));

  app.post('/login', loginIpRateLimit, loginRateLimit, asyncHandler(async (req, res) => {
    const wantsJson = req.is('application/json');
    const { password } = req.body || {};
    // One box takes an email or a staff phone number (field name kept as
    // "email" so existing forms and API callers keep working).
    const email = (req.body && (req.body.email || req.body.phone || req.body.login)) || '';
    const result = await authenticate(email, password);
    if (result.status === 'locked') {
      if (result.user) {
        await logSecurityEvent(tenantDb(result.user.churchId), req, {
          event: 'auth.login_locked',
          subject: loginLabel(result.user),
          actorId: result.user.id,
        });
      }
      const mins = Math.max(1, Math.ceil((result.until.getTime() - Date.now()) / 60000));
      const message = `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`;
      if (wantsJson) return res.status(423).json({ error: message });
      return authRoutes.renderLoginForm(req, res, { error: message, email });
    }
    if (result.status === 'unverified') {
      const message = 'Verify your email before signing in.';
      if (wantsJson) return res.status(403).json({ error: message, verificationRequired: true });
      return authRoutes.renderLoginForm(req, res, { error: message, email });
    }
    if (result.status !== 'ok') {
      if (result.user) {
        await logSecurityEvent(tenantDb(result.user.churchId), req, {
          event: 'auth.login_failed',
          subject: loginLabel(result.user),
          actorId: result.user.id,
        });
      }
      if (wantsJson) return res.status(401).json({ error: 'Incorrect email or password.' });
      return authRoutes.renderLoginForm(req, res, { error: 'Incorrect email or password.', email });
    }
    if (result.user.totpEnabled) {
      await createPendingMfaSession(req, result.user.id);
      if (wantsJson) return res.status(202).json({ ok: false, mfaRequired: true });
      return res.redirect('/login/mfa');
    }
    await createSession(req, result.user.id);
    await logSecurityEvent(tenantDb(result.user.churchId), req, {
      event: 'auth.login_succeeded',
      subject: loginLabel(result.user),
      actorId: result.user.id,
    });
    if (wantsJson) return res.json({ ok: true, user: { id: result.user.id, email: result.user.email, churchId: result.user.churchId } });
    return res.redirect('/welcome');
  }));

  app.get('/login/mfa', (req, res) => {
    if (res.locals.user) return res.redirect('/');
    if (!req.session.pendingMfaUserId || Date.now() - Number(req.session.pendingMfaAt || 0) > 5 * 60 * 1000) {
      return res.redirect('/login');
    }
    res.send(authPage('Security verification', `
      <p class="muted">Enter the six-digit code from your authenticator app, or use one recovery code.</p>
      <form class="form auth-form" method="post" action="/login/mfa">
        <label class="wide">Verification code<input name="code" required autofocus autocomplete="one-time-code"></label>
        <div class="actions"><button type="submit">Verify</button></div>
      </form>`));
  });

  app.post('/login/mfa', mfaRateLimit, asyncHandler(async (req, res) => {
    const wantsJson = req.is('application/json');
    const pendingUserId = req.session.pendingMfaUserId;
    const pendingAt = Number(req.session.pendingMfaAt || 0);
    if (!pendingUserId || Date.now() - pendingAt > 5 * 60 * 1000) {
      if (wantsJson) return res.status(401).json({ error: 'MFA challenge expired.' });
      return res.redirect('/login');
    }
    const user = await rawDb.user.findUnique({ where: { id: pendingUserId } });
    if (!user || user.deletedAt || !user.totpEnabled || !user.totpSecret) {
      return res.status(401).json({ error: 'MFA challenge is invalid.' });
    }
    const code = String(req.body?.code || '').trim();
    const validTotp = verifyTotp(user.totpSecret, code);
    const remainingRecoveryCodes = validTotp ? null : consumeRecoveryCode(user.totpRecoveryCodes, code);
    if (!validTotp && remainingRecoveryCodes === null) {
      await logSecurityEvent(tenantDb(user.churchId), req, {
        event: 'auth.mfa_failed',
        subject: loginLabel(user),
        actorId: user.id,
      });
      const message = 'Incorrect verification code.';
      if (wantsJson) return res.status(401).json({ error: message });
      return res.status(401).send(authPage('Security verification', `<p class="error">${message}</p><p><a href="/login/mfa">Try again</a></p>`));
    }
    if (remainingRecoveryCodes !== null) {
      await rawDb.user.update({
        where: { id: user.id },
        data: { totpRecoveryCodes: remainingRecoveryCodes },
      });
    }
    await createSession(req, user.id);
    await logSecurityEvent(tenantDb(user.churchId), req, {
      event: remainingRecoveryCodes !== null ? 'auth.mfa_recovery_succeeded' : 'auth.mfa_succeeded',
      subject: loginLabel(user),
      actorId: user.id,
    });
    if (wantsJson) return res.json({ ok: true, user: { id: user.id, email: user.email, churchId: user.churchId } });
    return res.redirect('/welcome');
  }));

  // End a read-only support view (the banner's End button) and go back to
  // the church's page in the console.
  app.post('/support/end', asyncHandler(async (req, res) => {
    const churchId = await endSupportView(req);
    res.redirect(churchId ? `/platform/churches/${encodeURIComponent(churchId)}` : '/platform');
  }));

  app.post('/logout', (req, res) => {
    const wantsJson = req.is('application/json');
    const user = res.locals.user;
    if (user) {
      void logSecurityEvent(res.locals.db, req, {
        event: 'auth.logout',
        subject: loginLabel(user),
        actorId: user.id,
      });
    }
    destroySession(req, () => {
      res.clearCookie('connect.sid');
      return wantsJson ? res.json({ ok: true }) : res.redirect('/login');
    });
  });

  app.get('/whoami', requireAuth, (req, res) => {
    res.json({ userId: res.locals.user.id, email: res.locals.user.email, churchId: res.locals.churchId });
  });

  // Accounts without finance access cannot open Communications or Reports
  // (lib/access.js); other areas check their own permissions.
  app.use(blockLimitedAreas);

  // Phase 2 module registrations — each is a standalone, fully-tested
  // Postgres/Prisma port of the matching routes/*.js file, not yet wired
  // into the live server.js (see church-mgmt-multitenant-rewrite memory).
  require('../routes-pg/preaching').register(app);
  require('../routes-pg/bible-classes').register(app);
  require('../routes-pg/inventory').register(app);
  require('../routes-pg/organizations').register(app);
  require('../routes-pg/attendance').register(app);
  require('../routes-pg/communications').register(app);
  require('../routes-pg/events').register(app);
  require('../routes-pg/members').register(app);
  require('../routes-pg/reports').register(app);
  require('../routes-pg/finance').register(app);
  require('../routes-pg/users').register(app);
  require('../routes-pg/settings').register(app);
  require('../routes-pg/platform').register(app);
  require('../routes-pg/push').register(app);

  // Phase 8: HTML route modules. Registered alongside (not instead of) the
  // JSON routes-pg/*.js modules above — HTML lives at bare paths (/preaching),
  // JSON at /api/... (see routes-pg/preaching.js), no collision.
  authRoutes.register(app); // GET /login, GET /signup (forms)
  require('../routes-pg-html/preaching').register(app);
  require('../routes-pg-html/preachers').register(app);
  require('../routes-pg-html/almanac').register(app);
  require('../routes-pg-html/bible-classes').register(app);
  require('../routes-pg-html/inventory').register(app);
  require('../routes-pg-html/organizations').register(app);
  require('../routes-pg-html/attendance').register(app);
  require('../routes-pg-html/communications').register(app);
  require('../routes-pg-html/events').register(app);
  require('../routes-pg-html/member-import').register(app);
  require('../routes-pg-html/members').register(app);
  require('../routes-pg-html/reports').register(app);
  require('../routes-pg-html/allowances').register(app);
  require('../routes-pg-html/finance').register(app);
  require('../routes-pg-html/cash-control').register(app);
  require('../routes-pg-html/users').register(app);
  require('../routes-pg-html/settings').register(app);
  require('../routes-pg-html/help').register(app);
  require('../routes-pg-html/platform-auth').register(app);
  require('../routes-pg-html/platform').register(app);
  require('../routes-pg-html/platform-payments').register(app);
  require('../routes-pg-html/platform-sms').register(app);
  require('../routes-pg-html/platform-health').register(app);
  require('../routes-pg-html/trial-enquiries').register(app);
  require('../routes-pg-html/platform-trials').register(app);
  require('../routes-pg-html/platform-support').register(app);
  require('../routes-pg-html/platform-announcements').register(app);
  require('../routes-pg-html/platform-almanac').register(app);
  require('../routes-pg-html/platform-operators-admin').register(app);
  require('../routes-pg-html/platform-errors').register(app);
  require('../routes-pg-html/unsubscribe').register(app);

  // The welcome screen: the church's logo for a few seconds right after sign-in (lib/welcome.js).
  // Only right after a sign-in (the session carries the flag); any other visit goes to the dashboard.
  app.get('/welcome', (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    if (!req.session.welcome) return res.redirect('/');
    delete req.session.welcome;
    if (res.locals.church && res.locals.church.welcomeAnimation === false) return res.redirect('/'); // the church turned it off in Settings
    const u = res.locals.user;
    const church = res.locals.church || {};
    res.set('Cache-Control', 'no-store');
    res.send(welcomePage({
      churchName: church.name, firstName: String(u.displayName || u.username || '').trim().split(/\s+/)[0],
      logoVersion: church.updatedAt ? new Date(church.updatedAt).getTime() : '', liturgical: res.locals.liturgical,
    }));
  });

  // Landing/dashboard are deferred past Phase 8a (see the plan) — a minimal
  // stub so the app has a sensible "/" while those don't exist yet.
  app.get('/', asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.send(landingPage(false));
    const body = await renderDashboard(res.locals.db, res.locals.user);
    res.page({ title: 'Dashboard', active: '/', noHeader: true, body });
  }));

  // Nothing matched: never Express's "Cannot GET /x".
  app.use((req, res) => {
    if (req.path.startsWith('/api/') || req.is('application/json')) return res.status(404).json({ error: 'Not found' });
    if (res.locals.user) return res.status(404).send('Not found'); // drawn by the page above
    return res.status(404).send(layout({
      bare: true, title: 'Page not found',
      body: '<p>That page doesn’t exist, or it has moved.</p><p><a href="/login">Sign in</a> · <a href="/">Home</a></p>',
    }));
  });

  Sentry.setupExpressErrorHandler(app);

  // Last resort: JSON for the API surface (never Express's default HTML
  // error page), a plain HTML error page for browser/form requests.
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    console.error('[tenant-http]', err);

    // A database outage is not an application error, and must not be reported
    // as one. The generic page below says "something went wrong" and offers a
    // link to the dashboard, which fails identically — during the August 2026
    // outage that left administrators with no way to tell a broken system from
    // an abandoned one, and nothing telling them their records were safe.
    //
    // Answered before the errorLog write on purpose: that write goes to the
    // same database that is down, so it can only fail, and 503 (with Retry-After)
    // is the honest status — this is temporary and must never be cached or
    // indexed as the state of the app.
    if (isDatabaseUnavailableError(err)) {
      res.set('Retry-After', '3600');
      if (req.is('application/json') || req.path.startsWith('/api/')) {
        return res.status(503).json({ error: 'service unavailable', message: 'database temporarily unavailable' });
      }
      return res.status(503).send(maintenancePage({
        // res.locals.church is usually unset here — resolving it is itself a
        // query, so during an outage it has already failed — and then the page
        // falls back to the product name. (Not the CHURCH_NAME setting: it
        // names one church, and every church's users would see it.)
        churchName: res.locals.church?.name || undefined,
        expectedBack: process.env.MAINTENANCE_EXPECTED_BACK || undefined,
        contactEmail: process.env.SUPPORT_EMAIL || undefined,
      }));
    }

    void rawDb.errorLog.create({
      data: {
        churchId: res.locals.churchId || null,
        method: String(req.method || '').slice(0, 16),
        path: redactUrl(req.originalUrl || req.path).slice(0, 500),
        message: String(err.message || err).slice(0, 2000),
        stack: err.stack ? String(err.stack).slice(0, 10000) : null,
        userId: res.locals.user?.id || null,
      },
    }).catch((logError) => console.error('[error-log] failed:', logError.message));
    // Refusals the user can act on (see LedgerError) are shown as-is. Anything
    // else is an unexpected failure whose message can carry SQL, table and
    // column names, so it stays in the server log and the error table only.
    if (err.expose) {
      const status = err.status || 400;
      if (req.is('application/json') || req.path.startsWith('/api/')) {
        return res.status(status).json({ error: err.message });
      }
      return res.status(status).send(layout({
        title: 'Not allowed', active: null, user: res.locals.user, liturgical: res.locals.liturgical,
        body: `<p class="error">${esc(err.message)}</p><p><a href="/">Back to dashboard</a></p>`,
      }));
    }
    if (req.is('application/json') || req.path.startsWith('/api/')) {
      return res.status(500).json({ error: 'internal error', message: IS_PRODUCTION ? 'An unexpected error occurred.' : err.message });
    }
    return res.status(500).send(layout({
      title: 'Something went wrong', active: null, user: res.locals.user, liturgical: res.locals.liturgical,
      body: `<p>Sorry, something went wrong on our end.</p><p><a href="/">Back to dashboard</a></p>`,
    }));
  });

  return app;
}

/**
 * Sweep expired session rows. Replaces connect-pg-simple's own 15-minute prune
 * timer (disabled above); call it from a place where Postgres is already awake.
 * Returns the number of rows removed.
 */
async function pruneExpiredSessions(tableName = 'session') {
  if (!/^[a-z_][a-z0-9_]*$/i.test(tableName)) throw new Error(`bad session table name: ${tableName}`);
  return rawDb.$executeRawUnsafe(`DELETE FROM "${tableName}" WHERE expire < NOW()`);
}

module.exports = { createTenantApp, pruneExpiredSessions, problemPage };
