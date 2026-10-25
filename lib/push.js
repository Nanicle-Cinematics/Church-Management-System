'use strict';
// Device notifications (Web Push): the browser or installed app shows them
// through the phone's or computer's own notification system, even when the
// app is closed. Needs VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY (generate with
// `npx web-push generate-vapid-keys`); without them this is a no-op and the
// "Turn on notifications" button is hidden. On iPhone and iPad, notifications
// work once the app has been added to the Home Screen (iOS 16.4 or later).

const webpush = require('web-push');
const { db: rawDb } = require('./tenant');

const UNDER_TEST_RUNNER = (process.execArgv || []).some((a) => a.startsWith('--test'))
  || (process.argv || []).some((a) => a.startsWith('--test'));

const publicKey = () => process.env.VAPID_PUBLIC_KEY || '';
const privateKey = () => process.env.VAPID_PRIVATE_KEY || '';
const pushReady = () => Boolean(publicKey() && privateKey());

let configured = '';
function configure() {
  const key = `${publicKey()}|${privateKey()}`;
  if (configured === key) return;
  // Push services want a way to reach the sender: an https site or a mailto.
  const site = process.env.PUBLIC_URL || '';
  const subject = process.env.VAPID_SUBJECT || (/^https:\/\//.test(site) ? site : 'mailto:alerts@example.com');
  webpush.setVapidDetails(subject, publicKey(), privateKey());
  configured = key;
}

/**
 * Notify every device the given users turned notifications on for.
 * payload: { title, body, url }. Expired subscriptions are removed.
 * Returns { sent, failed, removed } (all 0 when push is not set up).
 */
async function pushToUsers(churchId, userIds, payload) {
  const out = { sent: 0, failed: 0, removed: 0 };
  if (!userIds.length) return out;
  const subs = await rawDb.pushSubscription.findMany({ where: { churchId, userId: { in: userIds } } });
  if (!subs.length || !pushReady() || UNDER_TEST_RUNNER) return out;
  configure();
  const body = JSON.stringify({ title: payload.title, body: payload.body, url: payload.url || '/' });
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, { TTL: 24 * 60 * 60 });
      out.sent++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) {
        await rawDb.pushSubscription.deleteMany({ where: { id: s.id } });
        out.removed++;
      } else {
        out.failed++;
        console.error('[push] send failed:', e.statusCode || '', e.message);
      }
    }
  }
  return out;
}

module.exports = { pushToUsers, pushReady, vapidPublicKey: publicKey };
