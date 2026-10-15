'use strict';
// "View as church": a platform operator sees a church's app, read-only, to
// help with a problem it reported. The church decides: one of its admins
// turns on support access (Settings › Support access) for a limited time
// (churches.support_access_until), and can turn it off at any time.
//
// While it is on, an operator signed in to the console can start a view from
// the church's console page. The browser session then carries
// supportView = { churchId, operatorId, startedAt }, and each request is
// served as a read-only stand-in admin of that church:
//   - nothing can be changed: every POST/PUT/PATCH/DELETE is refused (except
//     ending the view), and so are exports and downloads, which copy data out
//   - every page shows a banner saying it is a support view, with End
//   - the view ends by itself once access runs out or is turned off, or the
//     operator's console session ends
// Starting and ending are written to the church's own security log.

const { db } = require('./tenant');
const { resolveSessionOperator } = require('./platform-operators');
const { requestIp, requestUserAgent } = require('./security-audit');

const DURATIONS = { 1: '1 hour', 24: '24 hours', 72: '3 days' };
const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// GETs that copy data out of the app.
const EXPORTS = /(\.csv|\.xlsx|\.json|\.pdf)$|\/export|\/download|\/backups?(\/|$)/i;

const accessOpen = (church, now = new Date()) => Boolean(church && church.supportAccessUntil && new Date(church.supportAccessUntil) > now);

async function logChurch(req, churchId, event, subject) {
  await db.securityAuditLog.create({ data: { churchId, actorId: null, event, subject, ip: requestIp(req), userAgent: requestUserAgent(req) } });
}

/**
 * For the request pipeline, after the signed-in church user is resolved:
 * returns the stand-in user for a live support view, or null (ending a view
 * that is no longer allowed).
 */
async function resolveSupportView(req) {
  const view = req.session && req.session.supportView;
  if (!view) return null;
  const operator = await resolveSessionOperator(req);
  const church = await db.church.findUnique({
    where: { id: view.churchId },
    select: { id: true, name: true, slug: true, plan: true, proUntil: true, suspendedAt: true, suspensionReason: true, deletedAt: true, deletionReason: true, supportAccessUntil: true },
  });
  if (!operator || operator.id !== view.operatorId || !accessOpen(church)) {
    delete req.session.supportView;
    if (church) await logChurch(req, church.id, 'support.view_ended', `Platform support (${operator ? operator.email : 'operator'}) stopped viewing: access ended`).catch(() => {});
    return null;
  }
  return {
    // Stand-in admin: sees what an admin with full finance access sees.
    id: 0, churchId: church.id, church, role: 'ADMIN', financeRole: 'FINANCE_ADMIN',
    username: 'support', displayName: `Support · ${operator.displayName || operator.email}`, email: null, phone: null,
    deletedAt: null, totpEnabled: false,
    supportView: { operatorEmail: operator.email, until: church.supportAccessUntil, startedAt: view.startedAt },
  };
}

/** Middleware: in a support view, refuse anything that changes or copies out data. */
function supportReadOnly(req, res, next) {
  if (!res.locals.supportView) return next();
  if (req.path === '/support/end') return next();
  if (READ_ONLY_METHODS.has(req.method) && !EXPORTS.test(req.path)) return next();
  const message = 'This is a read-only support view: nothing can be changed or exported.';
  if (req.path.startsWith('/api/') || req.is('application/json')) return res.status(403).json({ error: message });
  return res.status(403).send(message); // drawn inside the app by the refusal page middleware
}

async function startSupportView(req, operator, churchId) {
  const church = await db.church.findUnique({ where: { id: churchId }, select: { id: true, name: true, supportAccessUntil: true, deletedAt: true } });
  if (!church || church.deletedAt) return { error: 'Church not found.' };
  if (!accessOpen(church)) return { error: `${church.name} has not turned on support access. Ask one of its admins to turn it on in Settings › Support access.` };
  req.session.supportView = { churchId: church.id, operatorId: operator.id, startedAt: new Date().toISOString() };
  await logChurch(req, church.id, 'support.view_started', `Platform support (${operator.email}) started viewing the app, read-only`);
  return { church };
}

async function endSupportView(req) {
  const view = req.session && req.session.supportView;
  if (!view) return null;
  delete req.session.supportView;
  const operator = await resolveSessionOperator(req);
  await logChurch(req, view.churchId, 'support.view_ended', `Platform support (${operator ? operator.email : 'operator'}) stopped viewing`).catch(() => {});
  return view.churchId;
}

module.exports = { resolveSupportView, supportReadOnly, startSupportView, endSupportView, accessOpen, DURATIONS, EXPORTS };
