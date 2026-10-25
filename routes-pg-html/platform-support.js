'use strict';
// Platform › church page › Users: help a church's people who are stuck,
// without the operator touching the database:
//   - send a password-reset link (by email, by text, or shown to the operator
//     to pass on, e.g. on WhatsApp, for someone who signs in with a phone)
//   - unlock an account locked by wrong passwords
//   - resend the email-verification link
//   - change how they sign in (email and/or phone), with the same checks as
//     the church's own Users & Roles (lib/user-logins.js)
// Every action is written to the church's own security log, which its
// admins can read, and to the platform audit log.

const asyncHandler = require('../lib/async-handler');
const { flash } = require('../lib/tenant-flash');
const { db: rawDb, tenantDb } = require('../lib/tenant');
const { requireOperator, logPlatformEvent } = require('../lib/platform-operators');
const { requestIp, requestUserAgent } = require('../lib/security-audit');
const { createPasswordResetTokenForUser, createEmailVerificationToken } = require('../lib/auth');
const { sendEmailEach, sendSmsBatch, normalizePhoneGH } = require('../lib/delivery');
const { emailLinkBase } = require('../lib/public-url');
const { parseLogins, loginTakenMessage } = require('../lib/user-logins');
const { loginLabel } = require('../lib/phone');
const { startSupportView } = require('../lib/support-view');

const back = (churchId) => `/platform/churches/${encodeURIComponent(churchId)}#users`;

async function loadUser(req) {
  const id = Number(req.params.userId);
  if (!Number.isInteger(id)) return null;
  return rawDb.user.findFirst({ where: { id, churchId: req.params.id, deletedAt: null } });
}

async function record(req, res, user, event, subject) {
  await rawDb.securityAuditLog.create({ data: {
    churchId: user.churchId, actorId: null, event, subject: `Platform support: ${subject}`,
    ip: requestIp(req), userAgent: requestUserAgent(req),
  } });
  await logPlatformEvent(req, { operator: res.locals.operator, event, subject, churchId: user.churchId });
}

// Support can change how someone signs in, or make them a reset link, without
// the church's say-so (a locked-out admin cannot turn on support access). So the
// person it is about is always told, at the contact they had BEFORE the change:
// a change they did not ask for is then noticed. Failing to tell must not stop
// the help, so it reports back instead of throwing.
async function notifyUser(user, text) {
  try {
    if (user.email) {
      await sendEmailEach(tenantDb(user.churchId), [{ addr: user.email }], 'Church Manager support made a change to your account', text,
        { churchName: 'Church Manager', withFooter: false });
      return true;
    }
    const phone = normalizePhoneGH(user.phone);
    if (phone) {
      const r = await sendSmsBatch([phone], `Church Manager: ${text}`, { churchId: user.churchId, platform: true });
      return Boolean(r && r.ok);
    }
  } catch (e) {
    console.error('[platform-support] could not notify the user:', e.message);
  }
  return false;
}
const told = (notified) => (notified ? ' They have been told.' : ' They could not be told (no working email or phone).');

function register(app) {
  // "View as church": only while the church has turned on support access.
  app.post('/platform/churches/:id/view', requireOperator, asyncHandler(async (req, res) => {
    const r = await startSupportView(req, res.locals.operator, req.params.id);
    if (r.error) { flash(req, r.error); return res.redirect(back(req.params.id)); }
    await logPlatformEvent(req, { operator: res.locals.operator, event: 'support.view_started', subject: `Viewing ${r.church.name}, read-only`, churchId: r.church.id });
    res.redirect('/');
  }));

  const route = (action, handler) => app.post(`/platform/churches/:id/users/:userId/${action}`, requireOperator, asyncHandler(async (req, res) => {
    const user = await loadUser(req);
    if (!user) { flash(req, 'That user is not in this church.'); return res.redirect(back(req.params.id)); }
    return handler(req, res, user);
  }));

  route('reset', async (req, res, user) => {
    const via = String(req.body?.via || '');
    const base = emailLinkBase(req);
    if (!base) { flash(req, 'PUBLIC_URL is not set, so no reset link can be made.'); return res.redirect(back(user.churchId)); }
    if (via === 'email' && !user.email) { flash(req, 'This user has no email.'); return res.redirect(back(user.churchId)); }
    const phone = normalizePhoneGH(user.phone);
    if (via === 'sms' && !phone) { flash(req, 'This user has no phone number.'); return res.redirect(back(user.churchId)); }
    if (!['email', 'sms', 'show'].includes(via)) { flash(req, 'Choose how to send the link.'); return res.redirect(back(user.churchId)); }
    const who = loginLabel(user);
    // Written before the link exists, so an action can never go unlogged.
    await record(req, res, user, 'support.password_reset_link', `reset link for ${who} (${via === 'show' ? 'shown to the operator' : `by ${via}`})`);
    const { token } = await createPasswordResetTokenForUser(user.id);
    const link = `${base}/reset-password/${token}`;
    if (via === 'email') {
      await sendEmailEach(tenantDb(user.churchId), [{ addr: user.email }], 'Reset your Church Manager password',
        `Church Manager support sent you this link to set a new password. It works once, within one hour:\n\n${link}\n\nIf you did not ask for help, you can ignore this email.`,
        { churchName: 'Church Manager', withFooter: false });
      flash(req, `Reset link emailed to ${user.email}. It works once, within an hour.`, 'success');
    } else if (via === 'sms') {
      const r = await sendSmsBatch([phone], `Church Manager: set a new password (works once, within 1 hour): ${link}`, { churchId: user.churchId, platform: true });
      flash(req, r.ok ? `Reset link texted to ${user.phone}.` : `The text was not sent: ${r.error || r.message || 'no reason given'}`, r.ok ? 'success' : 'error');
    } else {
      const notified = await notifyUser(user, 'Church Manager support made a password reset link for your account (it works once, within one hour). If you did not ask support for help, tell your church admin right away and change your password.');
      flash(req, `Reset link for ${who} (works once, within an hour; pass it on privately): ${link}.${told(notified)}`, 'success');
    }
    res.redirect(back(user.churchId));
  });

  route('unlock', async (req, res, user) => {
    await record(req, res, user, 'support.account_unlocked', `unlocked ${loginLabel(user)}`);
    await rawDb.user.update({ where: { id: user.id }, data: { failedAttempts: 0, lockedUntil: null } });
    flash(req, `${loginLabel(user)} can sign in again.`, 'success');
    res.redirect(back(user.churchId));
  });

  route('verify', async (req, res, user) => {
    const base = emailLinkBase(req);
    if (!user.email || user.emailVerifiedAt) { flash(req, 'Nothing to verify: no email, or already verified.'); return res.redirect(back(user.churchId)); }
    if (!base) { flash(req, 'PUBLIC_URL is not set, so no verification link can be made.'); return res.redirect(back(user.churchId)); }
    await record(req, res, user, 'support.verification_resent', `verification email to ${user.email}`);
    const { token } = await createEmailVerificationToken(user.id);
    await sendEmailEach(tenantDb(user.churchId), [{ addr: user.email }], 'Verify your Church Manager email',
      `Verify your email within 24 hours:\n\n${base}/verify-email/${token}`, { churchName: 'Church Manager', withFooter: false });
    flash(req, `Verification link sent to ${user.email}.`, 'success');
    res.redirect(back(user.churchId));
  });

  route('sign-in', async (req, res, user) => {
    const logins = parseLogins(req.body || {});
    if (logins.error) { flash(req, logins.error); return res.redirect(back(user.churchId)); }
    const taken = await loginTakenMessage(rawDb, logins, user.churchId, user.id);
    if (taken) { flash(req, taken); return res.redirect(back(user.churchId)); }
    const data = { email: logins.email, phone: logins.phone };
    if (logins.email && logins.email !== user.email) data.emailVerifiedAt = new Date();
    const before = [user.email, user.phone].filter(Boolean).join(' / ') || '—';
    const after = [logins.email, logins.phone].filter(Boolean).join(' / ');
    await record(req, res, user, 'support.login_changed', `${user.username}: ${before} -> ${after}`);
    await rawDb.user.update({ where: { id: user.id }, data });
    const notified = await notifyUser(user, `Church Manager support changed how you sign in: it is now ${after}. If you did not ask support for help, tell your church admin right away.`);
    flash(req, `${user.displayName || user.username} now signs in with ${after}.${told(notified)}`, 'success');
    res.redirect(back(user.churchId));
  });
}

module.exports = { register };
