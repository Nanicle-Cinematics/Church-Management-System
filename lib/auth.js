'use strict';
// Postgres/Prisma-backed auth for the multi-tenant rewrite. Login identifier
// is `email` (globally unique across ALL churches, mirrors poultry-manager) —
// NOT `username`, which stays per-church/non-unique for display only.
//
// This module is deliberately NOT wired into server.js's live request path
// yet: server.js's current auth gate (session.userId -> SQLite users table)
// keeps working unchanged for the existing production church, whose data
// hasn't been migrated to Postgres yet (that's Phase 7). Flipping the live
// gate over happens once that migration runs — doing it earlier would strand
// the real church, which only exists in SQLite today.

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { db } = require('./tenant');
const { normalizePhone, looksLikeEmail } = require('./phone');

// Compared against when the email is unknown, so "no such account" costs the
// same bcrypt time as "wrong password" and response time doesn't reveal which
// addresses are registered.
const DUMMY_HASH = bcrypt.hashSync('timing-equalizer', 10);

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000; // 15 minutes
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Authenticate an email (or a staff phone number) + password, enforcing account lockout. Returns a
 * generic "invalid" outcome for unknown accounts and wrong passwords alike
 * so callers can avoid leaking which emails exist.
 * Uses the RAW (unscoped) client — the church isn't known until the user is
 * resolved by email or phone.
 */
async function authenticate(login, password) {
  // `login` is an email, or the phone number of a staff member without one.
  const phone = looksLikeEmail(login) ? null : normalizePhone(login);
  const user = phone
    ? await db.user.findUnique({ where: { phone } })
    : await db.user.findUnique({ where: { email: String(login || '').toLowerCase().trim() } });
  if (!user || user.deletedAt || !user.passwordHash) {
    if (typeof password === 'string' && password) await bcrypt.compare(password, DUMMY_HASH);
    return { status: 'invalid' };
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    return { status: 'locked', until: user.lockedUntil, user };
  }

  // A missing or non-string password (crafted JSON) used to make bcrypt throw,
  // turning a wrong guess into a 500 only for addresses that exist.
  const ok = typeof password === 'string' && password.length > 0 && await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    // Atomic increment: reading the counter and writing back read + 1 lets a
    // burst of parallel guesses all see the same value and never reach the limit.
    const bumped = await db.user.update({ where: { id: user.id }, data: { failedAttempts: { increment: 1 } } });
    const lock = bumped.failedAttempts >= MAX_FAILED_ATTEMPTS;
    if (!lock) return { status: 'invalid', user };
    const until = new Date(Date.now() + LOCK_DURATION_MS);
    // On lock, reset the counter so a fresh streak starts once it expires.
    await db.user.update({ where: { id: user.id }, data: { failedAttempts: 0, lockedUntil: until } });
    return { status: 'locked', until, user };
  }

  // Phone-only staff have no email to verify; an admin added them.
  if (process.env.REQUIRE_EMAIL_VERIFICATION === '1' && user.email && !user.emailVerifiedAt) {
    return { status: 'unverified', user };
  }

  if (user.failedAttempts > 0 || user.lockedUntil) {
    await db.user.update({ where: { id: user.id }, data: { failedAttempts: 0, lockedUntil: null } });
  }
  return { status: 'ok', user };
}

const tokenHash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

async function createEmailVerificationToken(userId) {
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user || user.deletedAt || !user.email) return null;
  const token = crypto.randomBytes(32).toString('hex');
  await db.emailVerificationToken.deleteMany({ where: { userId, usedAt: null } });
  await db.emailVerificationToken.create({
    data: {
      churchId: user.churchId, userId, tokenHash: tokenHash(token),
      expiresAt: new Date(Date.now() + VERIFY_TOKEN_TTL_MS),
    },
  });
  return { token, user };
}

async function verifyEmailToken(token) {
  const row = await db.emailVerificationToken.findUnique({ where: { tokenHash: tokenHash(token) } });
  if (!row || row.usedAt || row.expiresAt < new Date()) return null;
  await db.$transaction([
    db.user.update({ where: { id: row.userId }, data: { emailVerifiedAt: new Date() } }),
    db.emailVerificationToken.update({ where: { id: row.id }, data: { usedAt: new Date() } }),
  ]);
  return db.user.findUnique({ where: { id: row.userId } });
}

/**
 * Read-only check for the /verify-email confirmation PAGE (a GET request).
 * Deliberately does not mark the token used or the account verified — email
 * security gateways and link-preview bots auto-fetch GET links, and a GET
 * that mutated state would let a scanner burn the single-use token before
 * the real user ever clicks anything, leaving them with a false "invalid or
 * expired" error. The actual verification only happens via a user-submitted
 * POST — see verifyEmailToken, called from the confirm button's form.
 */
async function previewEmailVerificationToken(token) {
  const row = await db.emailVerificationToken.findUnique({ where: { tokenHash: tokenHash(token) } });
  return Boolean(row && !row.usedAt && row.expiresAt >= new Date());
}

/** Resolve the signed-in user for a request whose session carries userId, or null. */
async function resolveSessionUser(req) {
  const userId = req.session && req.session.userId;
  if (!userId) return null;
  const user = await db.user.findUnique({
    where: { id: userId },
    // plan/proUntil ride along so a plan check costs no extra query — the
    // church row is already being read on every authenticated request.
    include: { church: { select: {
      name: true, slug: true, suspendedAt: true, suspensionReason: true,
      deletedAt: true, deletionReason: true,
      plan: true, proUntil: true, welcomeAnimation: true,
    } } },
  });
  if (!user || user.deletedAt) return null;
  return user;
}

// The one place a full church session begins (signup, password sign-in,
// two-factor), so it also stamps the user's last sign-in (Platform ›
// Churches at risk). That stamp is best effort: it never fails a sign-in.
function createSession(req, userId) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((error) => {
      if (error) return reject(error);
      req.session.userId = userId;
      req.session.welcome = true; // the welcome screen (lib/welcome.js) is shown once, right after this
      req.session.save((saveError) => (saveError ? reject(saveError) : resolve()));
    });
  }).then(() => db.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } })
    .catch((e) => console.error('[auth] last sign-in not recorded:', e.message)));
}

function createPendingMfaSession(req, userId) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((error) => {
      if (error) return reject(error);
      req.session.pendingMfaUserId = userId;
      req.session.pendingMfaAt = Date.now();
      req.session.save((saveError) => (saveError ? reject(saveError) : resolve()));
    });
  });
}

function destroySession(req, cb) {
  req.session.destroy(cb);
}

/**
 * Issue a password reset token for the given email. Returns null if no
 * account matches (callers should show the same "if that email exists..."
 * message either way, to avoid leaking which emails are registered).
 * Real email delivery isn't wired into this stack yet (see the
 * communications module's dry-run deferral) — the caller is responsible
 * for surfacing the returned token/link to the requester directly.
 */
async function createPasswordResetToken(email) {
  const user = await db.user.findUnique({ where: { email: String(email).toLowerCase().trim() } });
  if (!user || user.deletedAt) return null;
  return issueResetToken(user);
}

/** The same, for a user picked by id (the platform console's support tools). */
async function createPasswordResetTokenForUser(userId) {
  const user = await db.user.findUnique({ where: { id: Number(userId) } });
  if (!user || user.deletedAt) return null;
  return issueResetToken(user);
}

async function issueResetToken(user) {
  const token = crypto.randomBytes(32).toString('hex');
  await db.passwordResetToken.deleteMany({ where: { userId: user.id, usedAt: null } });
  // Only the hash is stored (as verification tokens already are), so a database
  // read cannot be turned into working reset links.
  await db.passwordResetToken.create({
    data: { churchId: user.churchId, userId: user.id, token: tokenHash(token), expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS) },
  });
  return { token, user };
}

/** Look up a live (unexpired, unused) reset token, or null. */
async function findValidResetToken(token) {
  const row = await db.passwordResetToken.findUnique({ where: { token: tokenHash(token) } });
  if (!row || row.usedAt || row.expiresAt < new Date()) return null;
  return row;
}

/** Consume a reset token and set the new password. Throws if the token is invalid/expired/used. */
async function resetPasswordWithToken(token, newPassword) {
  const row = await findValidResetToken(token);
  if (!row) throw new Error('This reset link is invalid or has expired.');
  const passwordHash = await bcrypt.hash(newPassword, 10);
  await db.$transaction(async (tx) => {
    // Claim the token first: the check above and this write are separate
    // statements, so two submissions of the same link could both pass it.
    const claimed = await tx.passwordResetToken.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
    if (claimed.count !== 1) throw new Error('This reset link is invalid or has expired.');
    await tx.user.update({ where: { id: row.userId }, data: { passwordHash, failedAttempts: 0, lockedUntil: null } });
  });
  await revokeUserSessions(row.userId);
}

// A reset usually means "someone else may have my password": sign out every
// browser that was already logged in as this user. Rows are keyed by the
// session JSON, which carries userId (see createSession).
async function revokeUserSessions(userId, tableName = 'session') {
  try {
    await db.$executeRawUnsafe(`DELETE FROM "${tableName}" WHERE sess ->> 'userId' = $1`, String(userId));
  } catch (e) {
    console.error('[auth] could not revoke sessions after password reset:', e.message);
  }
}

module.exports = {
  authenticate, resolveSessionUser, createSession, createPendingMfaSession, destroySession,
  createPasswordResetToken, createPasswordResetTokenForUser, findValidResetToken, resetPasswordWithToken, revokeUserSessions,
  createEmailVerificationToken, verifyEmailToken, previewEmailVerificationToken,
};
