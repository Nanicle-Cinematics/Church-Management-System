'use strict';
// Accounts without finance access (an Editor or Viewer whose finance role is
// None) see a narrower app: Members, Attendance, Bible Classes and
// Organizations as their role allows; Events, Preaching Plan and Inventory
// read-only (Editors may still check people in and record RSVPs at events);
// no Finance, Communications or Reports; and a dashboard without money.
// Admins and anyone with a finance role are not limited by this.

const hasFinanceAccess = (user) => Boolean(user && (user.role === 'ADMIN' || (user.financeRole && user.financeRole !== 'NONE')));
const isLimited = (user) => Boolean(user) && !hasFinanceAccess(user);

// Path prefixes a limited account may not open at all (pages and API).
const LIMITED_BLOCKED = /^\/(api\/)?(communications|reports)(\/|$)/;

function refuse(req, res, message) {
  if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'forbidden' });
  return res.status(403).send(message);
}

/** App-level gate: limited accounts cannot reach Communications or Reports. */
function blockLimitedAreas(req, res, next) {
  if (isLimited(res.locals.user) && LIMITED_BLOCKED.test(req.path)) {
    return refuse(req, res, 'This area needs finance access. Ask an admin if you need it.');
  }
  next();
}

/** Route gate: an Admin, or an Editor with finance access. For Events,
 *  Preaching Plan and Inventory changes, which limited accounts only read. */
function requireEditorWithFullAccess(req, res, next) {
  const u = res.locals.user;
  if (u && (u.role === 'ADMIN' || (u.role === 'EDITOR' && hasFinanceAccess(u)))) return next();
  return refuse(req, res, 'Forbidden');
}

module.exports = { hasFinanceAccess, isLimited, blockLimitedAreas, requireEditorWithFullAccess };
