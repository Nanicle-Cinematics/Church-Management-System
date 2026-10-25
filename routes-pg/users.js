'use strict';
const { loginLabel } = require('../lib/phone');
const { parseLogins, loginTakenMessage, releasedOnDelete, freeUsernameFromRemovedUsers } = require('../lib/user-logins');
// Phase 6, module 1: Postgres/Prisma port of the /users section of
// server.js. Same coexistence approach as every prior phase.
//
// NOTABLE FIX, not just a port: the original gates create/reset/delete/
// disable-2FA behind `isUserManager`, which is hardcoded to
// `username === 'dunwelladmin'` (server.js:1005-1006) — a single-tenant hack
// that makes no sense once every church has its own ADMIN. This port uses
// `role === 'ADMIN'` (i.e. this church's own owner) for all of it instead,
// per the Phase-1 decision to not carry hardcoded single-tenant usernames
// forward. Role-change ("/role") already used the real requireOwner gate in
// the original, so that part is an unchanged port.

const bcrypt = require('bcryptjs');
const asyncHandler = require('../lib/async-handler');
const { canAddUser, upgradeMessage } = require('../lib/plan');
const { logSecurityEvent } = require('../lib/security-audit');
const { revokeUserSessions } = require('../lib/auth');
const { passwordProblem } = require('../lib/password-policy');

const ROLES = ['ADMIN', 'EDITOR', 'VIEWER'];
const FINANCE_ROLES = ['NONE', 'CASHIER', 'TREASURER', 'AUDITOR', 'FINANCE_ADMIN'];

function requireOwner(req, res, next) {
  if (res.locals.user && res.locals.user.role === 'ADMIN') return next();
  return res.status(403).json({ error: 'forbidden' });
}

function requireAuth(req, res, next) {
  if (!res.locals.user) return res.status(401).json({ error: 'not logged in' });
  next();
}

function shapeUser(u) {
  return {
    id: u.id, username: u.username, email: u.email, phone: u.phone || null, displayName: u.displayName,
    role: u.role, financeRole: u.financeRole, totpEnabled: u.totpEnabled, createdAt: u.createdAt,
  };
}

function register(app) {
  app.get('/api/users', requireOwner, asyncHandler(async (req, res) => {
    const rows = await res.locals.db.user.findMany({ where: { deletedAt: null }, orderBy: { username: 'asc' } });
    res.json(rows.map(shapeUser));
  }));

  app.post('/api/users', requireOwner, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const b = req.body || {};
    if (!b.username || !String(b.username).trim()) return res.status(400).json({ error: 'username is required' });
    const logins = parseLogins(b);
    if (logins.error) return res.status(400).json({ error: logins.error });
    const { email, phone } = logins;
    const passwordError = passwordProblem(b.password, { email });
    if (passwordError) return res.status(400).json({ error: passwordError });
    const role = ROLES.includes(b.role) ? b.role : 'VIEWER';
    const financeRole = FINANCE_ROLES.includes(b.financeRole) ? b.financeRole : 'NONE';

    // email is globally unique across ALL tenants (the login identifier —
    // see lib/provision.js), so this check must use the RAW client, not the
    // church-scoped one, to catch a collision with a DIFFERENT church's user.
    const { db: rawDb } = require('../lib/tenant');
    const taken = await loginTakenMessage(rawDb, { email, phone }, res.locals.churchId);
    if (taken) return res.status(409).json({ error: taken });

    // Same seat limit as the HTML form. Enforcing on only one of the two
    // surfaces would leave the API as a way around the plan.
    const activeUsers = await db.user.count({ where: { deletedAt: null } });
    if (!canAddUser(res.locals.church, activeUsers)) {
      return res.status(402).json({ error: upgradeMessage('users'), code: 'plan_limit' });
    }

    const passwordHash = await bcrypt.hash(String(b.password), 10);
    await freeUsernameFromRemovedUsers(db, String(b.username).trim());
    try {
      const user = await db.user.create({
        data: { username: String(b.username).trim(), email, phone, passwordHash, displayName: b.displayName || null, role, financeRole },
      });
      await logSecurityEvent(db, req, { event: 'user.created', subject: `${loginLabel(user)} (${role}/${financeRole})`, actorId: res.locals.user.id });
      res.status(201).json(shapeUser(user));
    } catch (e) {
      if (e.code === 'P2002') return res.status(409).json({ error: 'That username is already taken in this church' });
      throw e;
    }
  }));

  app.put('/api/users/:id/role', requireOwner, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const id = Number(req.params.id);
    const role = ROLES.includes(req.body.role) ? req.body.role : 'VIEWER';
    const financeRole = FINANCE_ROLES.includes(req.body.financeRole) ? req.body.financeRole : 'NONE';

    if (role !== 'ADMIN') {
      const [admins, target] = await Promise.all([
        db.user.count({ where: { role: 'ADMIN', deletedAt: null } }),
        db.user.findUnique({ where: { id } }),
      ]);
      if (target && target.role === 'ADMIN' && admins <= 1) {
        return res.status(400).json({ error: "Cannot demote the church's last admin — promote another user first" });
      }
    }
    try {
      const user = await db.user.update({ where: { id }, data: { role, financeRole } });
      await logSecurityEvent(db, req, { event: 'user.role_changed', subject: `${loginLabel(user)} -> ${role}/${financeRole}`, actorId: res.locals.user.id });
      res.json(shapeUser(user));
    } catch (e) {
      if (e.code === 'P2025') return res.status(404).json({ error: 'Not found' });
      throw e;
    }
  }));

  app.post('/api/users/:id/reset-password', requireOwner, asyncHandler(async (req, res) => {
    const { password } = req.body || {};
    const passwordError = passwordProblem(password);
    if (passwordError) return res.status(400).json({ error: passwordError });
    try {
      const passwordHash = await bcrypt.hash(String(password), 10);
      const id = Number(req.params.id);
      // Also clears a lockout, and (below) signs the user out everywhere: the
      // usual reason to reset a password is that the old one may be known.
      const target = await res.locals.db.user.update({ where: { id }, data: { passwordHash, failedAttempts: 0, lockedUntil: null } });
      if (id !== res.locals.user.id) await revokeUserSessions(id);
      await logSecurityEvent(res.locals.db, req, { event: 'user.password_reset_by_admin', subject: loginLabel(target), actorId: res.locals.user.id });
      res.status(204).end();
    } catch (e) {
      if (e.code === 'P2025') return res.status(404).json({ error: 'Not found' });
      throw e;
    }
  }));

  app.post('/api/users/:id/disable-2fa', requireOwner, asyncHandler(async (req, res) => {
    try {
      const target = await res.locals.db.user.update({ where: { id: Number(req.params.id) }, data: { totpSecret: null, totpEnabled: false, totpRecoveryCodes: null } });
      await logSecurityEvent(res.locals.db, req, { event: 'user.mfa_disabled_by_admin', subject: loginLabel(target), actorId: res.locals.user.id });
      res.status(204).end();
    } catch (e) {
      if (e.code === 'P2025') return res.status(404).json({ error: 'Not found' });
      throw e;
    }
  }));

  // Change how a user signs in: { email, phone, displayName }. Keeps at least one.
  app.put('/api/users/:id/login', requireOwner, asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const db = res.locals.db;
    const current = await db.user.findFirst({ where: { id, deletedAt: null } });
    if (!current) return res.status(404).json({ error: 'Not found' });
    const logins = parseLogins(req.body || {});
    if (logins.error) return res.status(400).json({ error: logins.error });
    const { db: rawDb } = require('../lib/tenant');
    const taken = await loginTakenMessage(rawDb, logins, res.locals.churchId, id);
    if (taken) return res.status(409).json({ error: taken });
    const data = { email: logins.email, phone: logins.phone };
    if (req.body && 'displayName' in req.body) data.displayName = String(req.body.displayName || '').trim() || null;
    if (logins.email && logins.email !== current.email) data.emailVerifiedAt = new Date();
    const updated = await db.user.update({ where: { id }, data });
    await logSecurityEvent(db, req, { event: 'user.login_changed', subject: `${current.username}: ${[current.email, current.phone].filter(Boolean).join(' / ') || '—'} -> ${[updated.email, updated.phone].filter(Boolean).join(' / ')}`, actorId: res.locals.user.id });
    res.json(shapeUser(updated));
  }));

  app.delete('/api/users/:id', requireOwner, asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (id === res.locals.user.id) return res.status(400).json({ error: "You can't delete your own account" });
    const target = await res.locals.db.user.findUnique({ where: { id } });
    if (!target) return res.status(404).json({ error: 'Not found' });
    // Soft delete frees the login email (it is globally unique) so the person
    // can be re-invited; the original stays embedded for the audit trail.
    if (!target.deletedAt) {
      await res.locals.db.user.update({ where: { id }, data: { deletedAt: new Date(), ...releasedOnDelete(target) } });
      await logSecurityEvent(res.locals.db, req, { event: 'user.deleted', subject: loginLabel(target), actorId: res.locals.user.id });
    }
    res.status(204).end();
  }));
}

module.exports = { register };
