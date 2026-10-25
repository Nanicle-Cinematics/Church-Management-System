'use strict';
// Device notifications: a signed-in browser registers (or removes) its Web
// Push subscription here. See lib/push.js and public/sw.js.

const asyncHandler = require('../lib/async-handler');
const { db: rawDb } = require('../lib/tenant');

const MAX = 2048;
const str = (v) => (typeof v === 'string' && v.length <= MAX ? v : '');

function register(app) {
  app.post('/api/push/subscribe', asyncHandler(async (req, res) => {
    const u = res.locals.user;
    if (!u) return res.status(401).json({ error: 'not logged in' });
    const b = req.body || {};
    const endpoint = str(b.endpoint);
    const p256dh = str(b.keys && b.keys.p256dh);
    const auth = str(b.keys && b.keys.auth);
    if (!/^https:\/\//.test(endpoint) || !p256dh || !auth) return res.status(400).json({ error: 'invalid subscription' });
    const data = { churchId: res.locals.churchId, userId: u.id, p256dh, auth, userAgent: String(req.get('user-agent') || '').slice(0, 300) || null };
    // An endpoint belongs to one browser; if someone else signs in on it, it moves to them.
    await rawDb.pushSubscription.upsert({ where: { endpoint }, create: { endpoint, ...data }, update: data });
    res.status(201).json({ ok: true });
  }));

  app.post('/api/push/unsubscribe', asyncHandler(async (req, res) => {
    const u = res.locals.user;
    if (!u) return res.status(401).json({ error: 'not logged in' });
    const endpoint = str((req.body || {}).endpoint);
    await rawDb.pushSubscription.deleteMany({ where: { endpoint, userId: u.id } });
    res.json({ ok: true });
  }));
}

module.exports = { register };
