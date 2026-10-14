'use strict';
// Phase 8e: HTML port of the /users section of server.js onto the Postgres
// stack. Registered ALONGSIDE routes-pg/users.js (JSON at /api/users, this
// is the bare-path HTML surface).
//
// NOTABLE FIX carried over from routes-pg/users.js (not just a port): the
// original gates create/reset/delete/disable-2FA behind `isUserManager`,
// hardcoded to `username === 'dunwelladmin'` — a single-tenant hack. This
// port uses `role === 'ADMIN'` (this church's own owner) uniformly instead,
// matching routes-pg/users.js's already-made Phase-1 decision.
//
// New user creation now requires an email (globally-unique login identifier
// — see lib/provision.js/lib/auth.js), not just a username+password, since
// login is email-based on this stack.

const bcrypt = require('bcryptjs');
const asyncHandler = require('../lib/async-handler');
const { esc } = require('../lib/format');
const { pageHero, table } = require('../lib/views');
const { flash } = require('../lib/tenant-flash');
const { logActivity } = require('../lib/tenant-activity');
const { logSecurityEvent } = require('../lib/security-audit');
const { revokeUserSessions } = require('../lib/auth');
const { db: rawDb } = require('../lib/tenant');
const { loginLabel } = require('../lib/phone');
const { parseLogins, loginTakenMessage, releasedOnDelete, freeUsernameFromRemovedUsers } = require('../lib/user-logins');
const { canAddUser, upgradeMessage } = require('../lib/plan');

const ROLES = ['ADMIN', 'EDITOR', 'VIEWER'];
const FINANCE_ROLES = ['NONE', 'CASHIER', 'TREASURER', 'AUDITOR', 'FINANCE_ADMIN'];
const FINANCE_ROLE_LABELS = { NONE: 'No finance access', CASHIER: 'Cashier', TREASURER: 'Steward / Treasurer', AUDITOR: 'Auditor', FINANCE_ADMIN: 'Finance admin' };

function requireOwner(req, res, next) {
  if (!res.locals.user) return res.redirect('/login');
  if (res.locals.user.role === 'ADMIN') return next();
  return res.status(403).send('Forbidden');
}

function register(app) {
  app.get('/users', requireOwner, asyncHandler(async (req, res) => {
    const users = await res.locals.db.user.findMany({ where: { deletedAt: null }, orderBy: { username: 'asc' } });
    const rows = users.map((u) => [
      esc(u.username), esc(u.displayName) || '—',
      [u.email, u.phone].filter(Boolean).map(esc).join('<br>') || '—',
      `<span class="role-badge role-${esc(u.role.toLowerCase())}">${esc({ ADMIN: 'Admin', EDITOR: 'Editor', VIEWER: 'Viewer' }[u.role] || u.role)}</span>`,
      esc(FINANCE_ROLE_LABELS[u.financeRole || 'NONE'] || u.financeRole),
      u.totpEnabled ? '<span class="pill pill-admin" title="2FA active">2FA ✓</span>' : '<span class="muted-text">—</span>',
      esc(u.createdAt.toISOString().slice(0, 10)),
      `<div class="u-actions"><form method="post" action="/users/${u.id}/role" class="inline">
         <select name="role">${ROLES.map((r) => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${r.toLowerCase()}</option>`).join('')}</select>
         <select name="financeRole">${Object.entries(FINANCE_ROLE_LABELS).map(([v, l]) => `<option value="${v}" ${(u.financeRole || 'NONE') === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
         <button type="submit">Save</button>
       </form>
       <a class="btn ghost" href="/users/${u.id}/edit">Edit sign-in</a>
       <form method="post" action="/users/${u.id}/reset" class="inline">
         <input type="password" name="password" placeholder="new password" minlength="8" required>
         <button type="submit">Reset</button>
       </form>
       ${u.totpEnabled ? `<form method="post" action="/users/${u.id}/disable-2fa" class="inline" onsubmit="return confirm('Disable 2FA for ${esc(u.username)}?')"><button type="submit">Disable 2FA</button></form>` : ''}
       ${u.id !== res.locals.user.id ? `<form method="post" action="/users/${u.id}/delete" class="inline" onsubmit="return confirm('Delete ${esc(u.username)}?')"><button class="danger" type="submit">Delete</button></form>` : ''}</div>`,
    ]);
    const body = `
      ${pageHero('Users & Roles', 'Admin-only access control for staff and ministry administrators.')}
      <p class="muted-text">Any administrator can set a user's access level: <strong>Admin</strong> = everything, including users, settings, deleting and sending messages; <strong>Editor</strong> = add and edit members, attendance, events, classes, organizations, inventory, the preaching plan and announcements; <strong>Viewer</strong> = read-only.</p>
      <p class="muted-text">Finance roles are separate: <strong>Cashiers</strong> record income/expenses, <strong>Treasurers</strong> record and review accounting, <strong>Auditors</strong> review accounting only, and <strong>Finance admins</strong> can do both. An Editor or Viewer with no finance role sees only Members, Attendance, Bible Classes and Organizations, plus Events, the Preaching Plan and Inventory read-only (Editors can still check people in at events); Finance, Communications and Reports are hidden.</p>
      <div class="page-actions"><a class="btn primary" href="/users/new">＋ New user</a></div>
      ${table(['Username', 'Display name', 'Signs in with', 'Role', 'Finance role', '2FA', 'Created', 'Actions'], rows)}`;
    res.page({ title: 'Users', active: '/users', noHeader: true, body });
  }));

  app.get('/users/new', requireOwner, (req, res) => {
    const body = `
      <form class="form" method="post" action="/users">
        <label>Username<input name="username" required></label>
        <label>Display name<input name="displayName"></label>
        <label>Email<input type="email" name="email" autocomplete="off"></label>
        <label>Phone number<input type="tel" name="phone" inputmode="tel" placeholder="e.g. 024 412 7781" autocomplete="off"></label>
        <p class="hint" style="grid-column:1/-1;margin:-4px 0 0">Give an email, a phone number, or both: they sign in with either. Without an email they cannot reset a forgotten password themselves; you reset it for them here.</p>
        <label>Password<input type="password" name="password" required minlength="8"></label>
        <label>Role<select name="role">
          <option value="ADMIN">admin (full access)</option>
          <option value="EDITOR">editor (add and edit)</option>
          <option value="VIEWER" selected>viewer (read-only)</option>
        </select>
        <span class="hint">Admins manage everything, including users and settings. Editors add and edit records but cannot delete, export or send messages. Viewers read only. Money is controlled by the Finance role below.</span></label>
        <label>Finance role<select name="financeRole">
          ${Object.entries(FINANCE_ROLE_LABELS).map(([v, l]) => `<option value="${v}"${v === 'NONE' ? ' selected' : ''}>${esc(l)}</option>`).join('')}
        </select>
        <span class="hint">Finance roles control access to the Finance module. With None, an Editor or Viewer cannot open Finance, Communications or Reports, and Events, the Preaching Plan and Inventory are read-only.</span></label>
        <div class="actions form-actions">
          <a class="btn ghost" href="/users">Cancel</a>
          <button type="submit">Create user</button>
        </div>
      </form>`;
    res.page({ title: 'New user', active: '/users', noHeader: true, body: `${pageHero('New user', '')}${body}` });
  });

  app.post('/users', requireOwner, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const b = req.body || {};
    if (!b.username || !String(b.username).trim()) { flash(req, 'Username is required.'); return res.redirect('/users/new'); }
    // Sign-in is by email, by phone number, or either: at least one is needed.
    const logins = parseLogins(b);
    if (logins.error) { flash(req, logins.error); return res.redirect('/users/new'); }
    const { email, phone } = logins;
    if (!b.password || String(b.password).length < 8) { flash(req, 'Password must be at least 8 characters.'); return res.redirect('/users/new'); }
    const role = ROLES.includes(b.role) ? b.role : 'VIEWER';
    const financeRole = FINANCE_ROLES.includes(b.financeRole) ? b.financeRole : 'NONE';

    const taken = await loginTakenMessage(rawDb, { email, phone }, res.locals.churchId);
    if (taken) { flash(req, taken); return res.redirect('/users/new'); }

    // Seat limit. Checked against active accounts only, so a soft-deleted user
    // frees its seat, and enforced here rather than by disabling anyone: a
    // church already over the limit keeps its people and simply cannot add.
    const activeUsers = await db.user.count({ where: { deletedAt: null } });
    if (!canAddUser(res.locals.church, activeUsers)) {
      flash(req, upgradeMessage('users'));
      return res.redirect('/settings');
    }

    const passwordHash = await bcrypt.hash(String(b.password), 10);
    // A removed user may still hold this username; it is free to reuse.
    await freeUsernameFromRemovedUsers(db, String(b.username).trim());
    try {
      const user = await db.user.create({
        data: { username: String(b.username).trim(), email, phone, passwordHash, displayName: b.displayName || null, role, financeRole },
      });
      await logActivity(db, 'user_created', `User created: ${user.username} (${role})`, '/users', res.locals.user.id);
      await logSecurityEvent(db, req, { event: 'user.created', subject: `${loginLabel(user)} (${role}/${financeRole})`, actorId: res.locals.user.id });
    } catch (e) {
      if (e.code !== 'P2002') throw e;
      flash(req, 'That username is already taken in this church.');
      return res.redirect('/users/new');
    }
    res.redirect('/users');
  }));

  app.post('/users/:id/role', requireOwner, asyncHandler(async (req, res) => {
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
        flash(req, "Cannot demote the church's last admin — promote another user first.");
        return res.redirect('/users');
      }
    }
    try {
      const updated = await db.user.update({ where: { id }, data: { role, financeRole } });
      await logActivity(db, 'user_role_changed',
        `Role changed for ${updated.username}: ${role} / finance ${financeRole}`, '/users', res.locals.user.id);
      // A privilege change is a security event, not just feed noise — same
      // trail (with IP/user-agent) the MFA changes in settings.js write to.
      await logSecurityEvent(db, req, {
        event: 'user.role_changed',
        subject: `${loginLabel(updated)} -> ${role}/${financeRole}`,
        actorId: res.locals.user.id,
      });
    } catch (e) {
      if (e.code !== 'P2025') throw e;
      return res.status(404).send('Not found');
    }
    res.redirect('/users');
  }));

  // Edit how a user signs in (email and/or phone) and their display name.
  app.get('/users/:id/edit', requireOwner, asyncHandler(async (req, res) => {
    const u = await res.locals.db.user.findFirst({ where: { id: Number(req.params.id), deletedAt: null } });
    if (!u) return res.status(404).send('Not found');
    const body = `
      ${pageHero(`Edit sign-in · ${u.displayName || u.username}`, 'Change how this person signs in. Their password, role and history stay as they are.')}
      <form class="form" method="post" action="/users/${u.id}/edit">
        <label>Username<input value="${esc(u.username)}" disabled></label>
        <label>Display name<input name="displayName" value="${esc(u.displayName || '')}"></label>
        <label>Email<input type="email" name="email" value="${esc(u.email || '')}" autocomplete="off"></label>
        <label>Phone number<input type="tel" name="phone" inputmode="tel" value="${esc(u.phone || '')}" placeholder="e.g. 024 412 7781" autocomplete="off"></label>
        <p class="hint" style="grid-column:1/-1;margin:-4px 0 0">Keep at least one. They sign in with either. Without an email they cannot reset a forgotten password themselves; you reset it for them in Users &amp; Roles.</p>
        <div class="actions"><a class="btn ghost" href="/users">Cancel</a><button type="submit">Save sign-in</button></div>
      </form>`;
    res.page({ title: 'Edit sign-in', active: '/users', noHeader: true, body });
  }));

  app.post('/users/:id/edit', requireOwner, asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const db = res.locals.db;
    const current = await db.user.findFirst({ where: { id, deletedAt: null } });
    if (!current) return res.status(404).send('Not found');
    const logins = parseLogins(req.body || {});
    if (logins.error) { flash(req, logins.error); return res.redirect(`/users/${id}/edit`); }
    const taken = await loginTakenMessage(rawDb, logins, res.locals.churchId, id);
    if (taken) { flash(req, taken); return res.redirect(`/users/${id}/edit`); }
    const displayName = String((req.body && req.body.displayName) || '').trim() || null;
    // An email set by an admin counts as checked, as a phone number does, so a
    // changed address does not lock the person out pending verification.
    const emailChanged = logins.email !== current.email;
    await db.user.update({ where: { id }, data: {
      email: logins.email, phone: logins.phone, displayName,
      ...(emailChanged && logins.email ? { emailVerifiedAt: new Date() } : {}),
    } });
    const before = [current.email, current.phone].filter(Boolean).join(' / ') || '—';
    const after = [logins.email, logins.phone].filter(Boolean).join(' / ');
    await logActivity(db, 'user_login_changed', `Sign-in details changed for ${current.username}`, '/users', res.locals.user.id);
    await logSecurityEvent(db, req, { event: 'user.login_changed', subject: `${current.username}: ${before} -> ${after}`, actorId: res.locals.user.id });
    flash(req, `Sign-in details saved for ${current.displayName || current.username}.`, 'success');
    res.redirect('/users');
  }));

  app.post('/users/:id/reset', requireOwner, asyncHandler(async (req, res) => {
    const { password } = req.body || {};
    if (!password || String(password).length < 8) { flash(req, 'Password must be at least 8 characters.'); return res.redirect('/users'); }
    try {
      const passwordHash = await bcrypt.hash(String(password), 10);
      const resetId = Number(req.params.id);
      // Also clears a lockout and signs the user out everywhere (see the API twin).
      const target = await res.locals.db.user.update({ where: { id: resetId }, data: { passwordHash, failedAttempts: 0, lockedUntil: null } });
      if (resetId !== res.locals.user.id) await revokeUserSessions(resetId);
      await logActivity(res.locals.db, 'user_password_reset', `Password reset for ${target.username}`, '/users', res.locals.user.id);
      await logSecurityEvent(res.locals.db, req, {
        event: 'user.password_reset_by_admin',
        subject: loginLabel(target),
        actorId: res.locals.user.id,
      });
      flash(req, 'Password reset.', 'success');
    } catch (e) {
      if (e.code !== 'P2025') throw e;
      return res.status(404).send('Not found');
    }
    res.redirect('/users');
  }));

  app.post('/users/:id/disable-2fa', requireOwner, asyncHandler(async (req, res) => {
    try {
      const target = await res.locals.db.user.update({ where: { id: Number(req.params.id) }, data: { totpSecret: null, totpEnabled: false, totpRecoveryCodes: null } });
      await logActivity(res.locals.db, 'user_2fa_disabled', `Two-factor disabled for ${target.username}`, '/users', res.locals.user.id);
      // Distinct from settings.js's self-service 'auth.mfa_disabled' — this is
      // an admin disabling it on someone else's account.
      await logSecurityEvent(res.locals.db, req, {
        event: 'user.mfa_disabled_by_admin',
        subject: loginLabel(target),
        actorId: res.locals.user.id,
      });
    } catch (e) {
      if (e.code !== 'P2025') throw e;
      return res.status(404).send('Not found');
    }
    res.redirect('/users');
  }));

  app.post('/users/:id/delete', requireOwner, asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (id === res.locals.user.id) { flash(req, "You can't delete your own account."); return res.redirect('/users'); }
    try {
      // Soft delete frees the login email (globally unique) so the person can
      // be re-invited; the original stays embedded for the audit trail.
      const current = await res.locals.db.user.findUnique({ where: { id } });
      if (!current) return res.status(404).send('Not found');
      // Username, email and phone are all freed for reuse (originals kept inside).
      if (!current.deletedAt) await res.locals.db.user.update({ where: { id }, data: { deletedAt: new Date(), ...releasedOnDelete(current) } });
      await logActivity(res.locals.db, 'user_deleted', `User account deleted: ${current.username}`, '/users', res.locals.user.id);
      await logSecurityEvent(res.locals.db, req, {
        event: 'user.deleted',
        subject: loginLabel(current),
        actorId: res.locals.user.id,
      });
    } catch (e) {
      if (e.code !== 'P2025') throw e;
      return res.status(404).send('Not found');
    }
    res.redirect('/users');
  }));
}

module.exports = { register };
