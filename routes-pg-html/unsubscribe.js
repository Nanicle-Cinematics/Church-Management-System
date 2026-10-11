'use strict';
// Public opt-out page. Every broadcast email footer links to /u/<token>
// (lib/delivery.js) but nothing served it, so the link 404'd for every
// recipient. The token is the member's unguessable unsubscribeToken
// (globally @unique); possession is the credential, as with /checkin/:token.
//
// GET only shows a confirm button and POST does the opt-out: mail scanners and
// link previewers fetch GET links automatically and must not unsubscribe
// people (same reasoning as /verify-email/:token).

const asyncHandler = require('../lib/async-handler');
const { esc } = require('../lib/format');
const { authPage } = require('../lib/tenant-shell');
const { db: rawDb, tenantDb } = require('../lib/tenant');
const { logActivity } = require('../lib/tenant-activity');
const { createRateLimiter } = require('../lib/rate-limit');

const unsubscribeRateLimit = createRateLimiter({ windowMs: 10 * 60 * 1000, max: 30, key: (req) => req.ip });

async function resolve(token) {
  if (!/^[a-f0-9]{16,64}$/i.test(String(token || ''))) return null;
  const member = await rawDb.member.findUnique({
    where: { unsubscribeToken: String(token) },
    include: { church: { select: { name: true, suspendedAt: true, deletedAt: true } } },
  });
  if (!member || member.deletedAt || member.church.deletedAt) return null;
  return member;
}

const notFound = (res) => res.status(404).send(authPage('Link not recognized', '<p>This unsubscribe link is not valid.</p>'));

function register(app) {
  app.get('/u/:token', unsubscribeRateLimit, asyncHandler(async (req, res) => {
    const member = await resolve(req.params.token);
    if (!member) return notFound(res);
    // The page deliberately shows no personal details about the member.
    res.send(authPage('Unsubscribe', `
      <p>Stop receiving SMS and email messages from <strong>${esc(member.church.name)}</strong>?</p>
      <form class="form auth-form" method="post" action="/u/${esc(req.params.token)}">
        <div class="actions"><button type="submit">Yes, unsubscribe me</button></div>
      </form>`));
  }));

  app.post('/u/:token', unsubscribeRateLimit, asyncHandler(async (req, res) => {
    const member = await resolve(req.params.token);
    if (!member) return notFound(res);
    const db = tenantDb(member.churchId);
    await db.member.update({ where: { id: member.id }, data: { preferredChannel: 'NONE' } });
    await logActivity(db, 'member_unsubscribed', `${member.firstName} ${member.lastName} unsubscribed from messages`, `/members/${member.id}`, null);
    res.send(authPage('Unsubscribed', `<p class="success">You have been unsubscribed. You will no longer receive messages from ${esc(member.church.name)}.</p>
      <p class="muted-text">If this was a mistake, ask the church office to update your preferences.</p>`));
  }));
}

module.exports = { register };
