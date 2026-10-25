'use strict';
// Platform operators: the people who run the SaaS (every church's plan and
// access). They are a separate kind of account from church users:
//
// - their own table (platform_operators), with no church and no tenant data;
// - their own sign-in at /platform/login, which sets session.operatorId and
//   never session.userId, so an operator session cannot open church pages
//   and a church session cannot open /platform (each login regenerates the
//   session, so one browser holds one identity at a time);
// - two-factor is mandatory: an operator without it is sent to set it up
//   before they can see anything;
// - accounts are created only by scripts/platform-operator.js on the server.
//
// Every operator action goes to platform_audit_log.

const bcrypt = require('bcryptjs');
const { db } = require('./tenant');
const { requestIp, requestUserAgent } = require('./security-audit');

const DUMMY_HASH = bcrypt.hashSync('timing-equalizer', 10);
const MAX_FAILED_ATTEMPTS = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000;
// A password-checked operator has this long to finish two-factor (or, on
// the first sign-in, to install an authenticator app and scan the code).
const PENDING_TTL_MS = 10 * 60 * 1000;
// Console sessions end after this much inactivity, even though the cookie
// itself lives longer for church users.
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const MIN_PASSWORD_LENGTH = 12;

const normEmail = (email) => String(email || '').trim().toLowerCase();

/** Email + password with lockout. Unknown, disabled and wrong all look alike. */
async function authenticateOperator(email, password) {
  const operator = await db.platformOperator.findUnique({ where: { email: normEmail(email) } });
  if (!operator || operator.disabledAt) {
    if (typeof password === 'string' && password) await bcrypt.compare(password, DUMMY_HASH);
    return { status: 'invalid' };
  }
  if (operator.lockedUntil && operator.lockedUntil > new Date()) {
    return { status: 'locked', until: operator.lockedUntil, operator };
  }
  const ok = typeof password === 'string' && password.length > 0 && await bcrypt.compare(password, operator.passwordHash);
  if (!ok) {
    const bumped = await db.platformOperator.update({ where: { id: operator.id }, data: { failedAttempts: { increment: 1 } } });
    if (bumped.failedAttempts < MAX_FAILED_ATTEMPTS) return { status: 'invalid', operator };
    const until = new Date(Date.now() + LOCK_DURATION_MS);
    await db.platformOperator.update({ where: { id: operator.id }, data: { failedAttempts: 0, lockedUntil: until } });
    return { status: 'locked', until, operator };
  }
  if (operator.failedAttempts > 0 || operator.lockedUntil) {
    await db.platformOperator.update({ where: { id: operator.id }, data: { failedAttempts: 0, lockedUntil: null } });
  }
  return { status: 'ok', operator };
}

function regenerate(req, fill) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((error) => {
      if (error) return reject(error);
      fill(req.session);
      req.session.save((saveError) => (saveError ? reject(saveError) : resolve()));
    });
  });
}

/** Password accepted; two-factor (or its first-time setup) still to come. */
function startPendingOperator(req, operatorId) {
  return regenerate(req, (s) => { s.pendingOperatorId = operatorId; s.pendingOperatorAt = Date.now(); });
}

/** The pending operator id, or null once it has expired. */
function pendingOperatorId(req) {
  const id = req.session && req.session.pendingOperatorId;
  if (!id || Date.now() - Number(req.session.pendingOperatorAt || 0) > PENDING_TTL_MS) return null;
  return id;
}

function createOperatorSession(req, operatorId) {
  return regenerate(req, (s) => { s.operatorId = operatorId; s.operatorSeenAt = Date.now(); });
}

/** The signed-in operator for this request, or null (expired, disabled or no 2FA). */
async function resolveSessionOperator(req) {
  const id = req.session && req.session.operatorId;
  if (!id) return null;
  if (Date.now() - Number(req.session.operatorSeenAt || 0) > IDLE_TIMEOUT_MS) {
    delete req.session.operatorId;
    delete req.session.operatorSeenAt;
    return null;
  }
  const operator = await db.platformOperator.findUnique({ where: { id } });
  if (!operator || operator.disabledAt || !operator.totpEnabled) return null;
  req.session.operatorSeenAt = Date.now();
  return operator;
}

/** HTML gate for /platform pages. */
function requireOperator(req, res, next) {
  if (res.locals.operator) return next();
  return res.redirect('/platform/login');
}

/** JSON gate for /api/platform. */
function requireOperatorJson(req, res, next) {
  if (res.locals.operator) return next();
  return res.status(401).json({ error: 'platform operator sign-in required' });
}

async function logPlatformEvent(req, { operator, event, subject, churchId }) {
  try {
    await db.platformAuditLog.create({
      data: {
        operatorId: operator ? operator.id : null,
        operatorEmail: operator ? operator.email : null,
        churchId: churchId || null,
        event: String(event).slice(0, 100),
        subject: subject ? String(subject).slice(0, 255) : null,
        ip: requestIp(req),
        userAgent: requestUserAgent(req),
      },
    });
  } catch (error) {
    console.error('[platform-audit] failed:', error.message);
  }
}

// Sign an operator out of every browser (password reset, 2FA reset, disable).
async function revokeOperatorSessions(operatorId, tableName = 'session') {
  try {
    await db.$executeRawUnsafe(
      `DELETE FROM "${tableName}" WHERE sess ->> 'operatorId' = $1 OR sess ->> 'pendingOperatorId' = $1`,
      String(operatorId),
    );
  } catch (e) {
    console.error('[platform-operators] could not revoke sessions:', e.message);
  }
}

async function hashOperatorPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  return bcrypt.hash(password, 12);
}

module.exports = {
  authenticateOperator, startPendingOperator, pendingOperatorId, createOperatorSession,
  resolveSessionOperator, requireOperator, requireOperatorJson, logPlatformEvent,
  revokeOperatorSessions, hashOperatorPassword, normEmail,
  MIN_PASSWORD_LENGTH, IDLE_TIMEOUT_MS,
};
