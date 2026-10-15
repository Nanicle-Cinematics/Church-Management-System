'use strict';
// The SMS account's balance (Platform › SMS), checked hourly, and an alert to
// the operators when it falls below a threshold, so churches' texts don't
// stop without warning. State lives in platform_settings:
//   sms_balance            { balance, provider, checkedAt, raw, error, alertedAt }
//   sms_balance_threshold  number (default SMS_BALANCE_ALERT_BELOW, else 200)
// A low balance is alerted once, then again only each 24 hours it stays low;
// topping up above the threshold clears it.

const { db } = require('./tenant');
const { fetchSmsBalance, sendSmsBatch, normalizePhoneGH, smsDeliveryInfo } = require('./delivery');

const DAY_MS = 24 * 60 * 60 * 1000;
const KEY = 'sms_balance';
const THRESHOLD_KEY = 'sms_balance_threshold';

async function getSetting(key, fallback = null) {
  const row = await db.platformSetting.findUnique({ where: { key } });
  return row ? row.value : fallback;
}
function setSetting(key, value) {
  return db.platformSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
}

async function balanceThreshold() {
  const saved = await getSetting(THRESHOLD_KEY);
  const n = Number(saved ?? process.env.SMS_BALANCE_ALERT_BELOW ?? 200);
  return Number.isFinite(n) && n >= 0 ? n : 200;
}

const balanceState = () => getSetting(KEY, null);

/**
 * Check the balance now, store it, and alert if it is low. `alert(text, opts)`
 * is the scheduler's alertOperators (passed in to avoid a require cycle).
 */
async function checkSmsBalance({ alert, now = new Date(), fetch: fetchBalance = fetchSmsBalance } = {}) {
  const previous = (await balanceState()) || {};
  const result = await fetchBalance();
  if (result.dryRun) return { ...result, skipped: true };
  const threshold = await balanceThreshold();
  const state = {
    provider: result.provider,
    checkedAt: now.toISOString(),
    raw: result.raw || null,
    error: result.ok ? null : result.error,
    // Keep the last good figure when a check fails, so the page still shows it.
    balance: result.ok ? result.balance : (previous.balance ?? null),
    balanceAt: result.ok ? now.toISOString() : (previous.balanceAt || null),
    alertedAt: previous.alertedAt || null,
  };
  let alerted = false;
  if (result.ok && result.balance < threshold) {
    if (!state.alertedAt || now - new Date(state.alertedAt) >= DAY_MS) {
      const label = smsDeliveryInfo().label;
      const text = `Church Manager: the ${label} SMS balance is ${result.balance}, below the alert level of ${threshold}. Top up soon, or churches' texts will stop.`;
      if (alert) await alert(text, { subject: 'Church Manager: SMS balance is low', level: 'warning' });
      const phone = normalizePhoneGH(process.env.ALERT_PHONE || '');
      if (phone) { try { await sendSmsBatch([phone], text); } catch (_) { /* the other channels still went */ } }
      state.alertedAt = now.toISOString();
      alerted = true;
    }
  } else if (result.ok) {
    state.alertedAt = null; // topped up: the next drop alerts straight away
  }
  await setSetting(KEY, state);
  return { ...result, threshold, alerted };
}

module.exports = { checkSmsBalance, balanceState, balanceThreshold, setSetting, THRESHOLD_KEY };
