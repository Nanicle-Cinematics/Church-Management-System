'use strict';
// Phase 9a: real SMS (Arkesel) + email (SMTP/Resend) delivery, ported from
// the original server.js (see commit f34d66b, the last commit before the
// Phase 8g Postgres cutover rewrote server.js — that's where these lived).
// Multi-tenant adaptation: the original's `loadEmailSettings()` read ONE
// global singleton row; here EmailSetting is per-church (churchId is its
// effective PK — see prisma/schema.prisma), so every function that touches
// email settings/logs takes a tenant-scoped `db` (res.locals.db) instead of
// reading a module-level global. SMS (Arkesel) has no per-church settings
// in the original either — it's one shared account/sender, unchanged here.

const crypto = require('crypto');

// SAFETY NET: real .env files in this project carry REAL SMTP/Arkesel
// secrets (the same ones deployed to Fly) — and @prisma/client auto-loads
// .env into process.env the moment anything requires it, independent of
// what the invoking shell exports. Relying on every test file to remember
// to delete these vars is fragile (a pre-existing test file almost
// triggered a real SMTP send to a non-reserved test domain the first time
// this module was wired into real code — see the Phase 9a memory entry).
// So: detect `node --test` (via execArgv, which reliably carries
// --test-isolation/--test-force-exit-style flags) and force dry-run
// unconditionally in that context, regardless of what secrets are present.
// Escape hatch (ALLOW_REAL_DELIVERY_IN_TESTS=1) exists for the rare case a
// test deliberately wants to exercise a real send.
const UNDER_TEST_RUNNER = (process.execArgv || []).some((a) => a.startsWith('--test'))
  || (process.argv || []).some((a) => a.startsWith('--test'));
const FORCE_DRY_RUN = UNDER_TEST_RUNNER && process.env.ALLOW_REAL_DELIVERY_IN_TESTS !== '1';

// SMS: one platform account, at Arkesel or mNotify (SMS_PROVIDER picks; it
// defaults to Arkesel, as before). Each church can have its own sender name
// once the operator approves it (see smsSenderFor); until then, and for
// churches without one, texts go out under the platform default.
const SMS_PROVIDER = String(process.env.SMS_PROVIDER || 'ARKESEL').toUpperCase();
const ARKESEL_API_KEY = process.env.ARKESEL_API_KEY || '';
const MNOTIFY_API_KEY = process.env.MNOTIFY_API_KEY || '';
const DEFAULT_SMS_SENDER = process.env.SMS_SENDER_ID || process.env.ARKESEL_SENDER || 'CHURCH';
const ARKESEL_URL = 'https://sms.arkesel.com/api/v2/sms/send';
const MNOTIFY_URL = 'https://api.mnotify.com/api/sms/quick';
// A sender name is 3–11 characters: letters and digits, with single spaces
// between words ("CHURCH MGMT"), never at either end. Gateways count the
// spaces in the 11.
const SENDER_ID_RE = /^(?=.{3,11}$)[A-Za-z0-9]+(?: [A-Za-z0-9]+)*$/;

const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM = process.env.SMTP_FROM || (SMTP_USER ? `Church <${SMTP_USER}>` : '');
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const RESEND_API_URL = 'https://api.resend.com/emails';
const PUBLIC_URL = process.env.PUBLIC_URL || '';

let smtpTransporter = null;
function getMailer() {
  if (smtpTransporter || !SMTP_HOST || !SMTP_USER || !SMTP_PASS) return smtpTransporter;
  const nodemailer = require('nodemailer');
  smtpTransporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  return smtpTransporter;
}

// Normalize Ghana phone numbers to E.164 (+233XXXXXXXXX). Moved here from
// its previously-duplicated home in routes-pg/communications.js and
// routes-pg-html/communications.js — both now import from this module.
function normalizePhoneGH(raw) {
  if (!raw) return null;
  let s = String(raw).replace(/[\s\-()]/g, '');
  if (s.startsWith('+')) return /^\+\d{8,15}$/.test(s) ? s : null;
  if (s.startsWith('00')) s = '+' + s.slice(2);
  else if (s.startsWith('0') && s.length === 10) s = '+233' + s.slice(1);
  else if (/^\d{9}$/.test(s)) s = '+233' + s;
  else if (/^233\d{9}$/.test(s)) s = '+' + s;
  return /^\+\d{8,15}$/.test(s) ? s : null;
}

/** Which SMS gateway is in use and whether it can send (for Settings and Communications). */
function smsDeliveryInfo() {
  const provider = SMS_PROVIDER === 'MNOTIFY' ? 'mnotify' : 'arkesel';
  const ready = provider === 'mnotify' ? !!MNOTIFY_API_KEY : !!ARKESEL_API_KEY;
  return {
    provider, label: provider === 'mnotify' ? 'mNotify' : 'Arkesel', ready,
    secretLabel: provider === 'mnotify' ? 'MNOTIFY_API_KEY' : 'ARKESEL_API_KEY', defaultSender: DEFAULT_SMS_SENDER,
  };
}

/**
 * The sender name a church's texts go out under: its own once approved,
 * otherwise the platform default. A church row (or just its id) may be passed.
 */
async function smsSenderFor(churchOrId) {
  if (!churchOrId) return DEFAULT_SMS_SENDER;
  let church = typeof churchOrId === 'object' ? churchOrId : null;
  if (!church || !('smsSenderStatus' in church)) {
    const { db } = require('./tenant'); // late: lib/tenant loads Prisma, which tests stub around
    church = await db.church.findUnique({ where: { id: church ? church.id : churchOrId }, select: { smsSenderId: true, smsSenderStatus: true } });
  }
  return church && church.smsSenderStatus === 'APPROVED' && SENDER_ID_RE.test(church.smsSenderId || '') ? church.smsSenderId : DEFAULT_SMS_SENDER;
}

// One bounded call to a gateway. An error page is HTML, so the body is read
// as text and parsed if it can be; `reason` then quotes the gateway's own
// words, or a snippet, instead of "Unexpected token <".
async function gatewayCall(url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
  return { status: res.status, ok: res.ok, json, text };
}
function gatewayReason(r) {
  const said = r.json && (r.json.message || r.json.error);
  if (typeof said === 'string' && said.trim()) return said;
  const snippet = String(r.text || '').replace(/\s+/g, ' ').trim().slice(0, 140);
  return snippet ? `HTTP ${r.status}: ${snippet}` : `HTTP ${r.status}`;
}

/**
 * Send one text to many numbers (E.164, from normalizePhoneGH). Pass the
 * church (`{ churchId }`) so its approved sender name is used.
 */
async function sendSmsBatch(recipients, message, opts = {}) {
  const info = smsDeliveryInfo();
  if (FORCE_DRY_RUN) return { ok: false, dryRun: true, message: 'Running under the test runner; forced dry run.' };
  if (!info.ready) return { ok: false, dryRun: true, message: `${info.secretLabel} not set; dry run.` };
  if (!recipients.length) return { ok: true, sent: 0 };
  const sender = opts.sender || await smsSenderFor(opts.churchId);
  let r;
  if (info.provider === 'mnotify') {
    // mNotify takes international numbers without the "+".
    r = await gatewayCall(`${MNOTIFY_URL}?key=${encodeURIComponent(MNOTIFY_API_KEY)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ recipient: recipients.map((n) => String(n).replace(/^\+/, '')), sender, message, is_schedule: false, schedule_date: '' }),
    });
    const ok = r.ok && r.json && r.json.status === 'success';
    return { ok, status: r.status, response: r.json, sent: recipients.length, sender, provider: 'mnotify', ...(ok ? {} : { error: gatewayReason(r) }) };
  }
  r = await gatewayCall(ARKESEL_URL, {
    method: 'POST',
    headers: { 'api-key': ARKESEL_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sender, message, recipients }),
  });
  // v2 answers {"status":"success"}; {"code":"ok"} was v1's.
  const ok = r.ok && r.json && (r.json.status === 'success' || r.json.code === 'ok');
  return { ok, status: r.status, response: r.json, sent: recipients.length, sender, provider: 'arkesel', ...(ok ? {} : { error: gatewayReason(r) }) };
}

// Every church sends through the platform's own SMTP/Resend account, so the
// From ADDRESS must be the platform's, never whatever a church typed into its
// settings: otherwise any signup could send mail "from" any address it likes
// (spoofing / phishing). A church controls the display name and the Reply-To.
function platformFromAddress() {
  const raw = process.env.EMAIL_FROM_ADDRESS || SMTP_FROM || SMTP_USER || '';
  const m = /<([^>]+)>/.exec(raw);
  return (m ? m[1] : raw).trim();
}
// '@' is removed too: a display name like "ceo@bank.example" is shown by many
// mail clients as if it were the sender's address.
const DISPLAY_NAME_UNSAFE = /[<>"@\r\n,;]/g;
function safeDisplayName(name, fallback) {
  const clean = String(name || '').replace(DISPLAY_NAME_UNSAFE, '').replace(/\s+/g, ' ').trim().slice(0, 64);
  return clean || String(fallback || 'Church').replace(DISPLAY_NAME_UNSAFE, '').trim() || 'Church';
}
function emailSenderHeader(settings, churchName) {
  const senderName = safeDisplayName(settings && settings.senderName, churchName);
  const senderEmail = platformFromAddress();
  return senderEmail ? `${senderName} <${senderEmail}>` : senderName;
}

function emailDeliveryInfo(settings, churchName) {
  const provider = String((settings && settings.provider) || 'SMTP').toUpperCase();
  const senderName = safeDisplayName(settings && settings.senderName, churchName);
  const senderEmail = platformFromAddress();
  // Replies go to the church: its reply-to, else the address it entered as sender.
  const replyToEmail = String((settings && (settings.replyToEmail || settings.senderEmail)) || SMTP_USER || '').trim();
  if (provider === 'RESEND') {
    return { provider: 'resend', ready: !!RESEND_API_KEY, secretLabel: 'RESEND_API_KEY', senderHeader: emailSenderHeader(settings, churchName), senderName, senderEmail, replyToEmail };
  }
  return { provider: 'smtp', ready: !!(SMTP_HOST && SMTP_USER && SMTP_PASS), secretLabel: 'SMTP_HOST / SMTP_USER / SMTP_PASS', senderHeader: emailSenderHeader(settings, churchName), senderName, senderEmail, replyToEmail };
}

async function logEmailAttempt(db, { recipient, subject, status, sentAt, errorMessage, provider, senderName, senderEmail, replyToEmail }) {
  try {
    await db.emailLog.create({
      data: {
        recipient: recipient || '', subject: subject || '', status: status || 'failed',
        sentAt: sentAt || new Date(), errorMessage: errorMessage || null, provider: provider || null,
        senderName: senderName || null, senderEmail: senderEmail || null, replyToEmail: replyToEmail || null,
      },
    });
  } catch (e) { console.error('[delivery] logEmailAttempt failed:', e.message); }
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Send one personalized email per recipient. `db` must be a tenant-scoped
 * client (res.locals.db) — loads that church's EmailSetting, logs every
 * attempt to that church's EmailLog. recipients: [{ addr, token? }].
 * opts: { html, replyTo, from, withFooter, settings, churchName }.
 */
async function sendEmailEach(db, recipients, subject, body, opts = {}) {
  const settings = opts.settings || await db.emailSetting.findFirst();
  const churchName = opts.churchName || 'Church';
  const delivery = emailDeliveryInfo(settings, churchName);
  if (FORCE_DRY_RUN) delivery.ready = false;
  const senderHeader = opts.from || delivery.senderHeader || SMTP_FROM;
  const replyTo = opts.replyTo || delivery.replyToEmail || '';
  const now = new Date();

  if (!delivery.ready) {
    for (const r of recipients) {
      await logEmailAttempt(db, {
        recipient: r.addr, subject, status: 'dry_run', sentAt: now,
        errorMessage: FORCE_DRY_RUN ? 'Running under the test runner; forced dry run.' : `Email provider not configured (${delivery.secretLabel})`,
        provider: delivery.provider, senderName: delivery.senderName, senderEmail: delivery.senderEmail, replyToEmail: replyTo || null,
      });
    }
    return { ok: false, dryRun: true, total: recipients.length, provider: delivery.provider };
  }
  if (!recipients.length) return { ok: true, sent: 0, failed: 0 };

  let sent = 0, failed = 0;
  const errors = [];
  for (const r of recipients) {
    const footer = (opts.withFooter !== false) && r.token
      ? (PUBLIC_URL ? `\n\n— ${churchName}\nTo stop receiving these messages, visit ${PUBLIC_URL}/u/${r.token}` : `\n\n— ${churchName}\nTo stop receiving messages, contact the church office.`)
      : '';
    try {
      if (delivery.provider === 'resend') {
        const payload = { from: senderHeader, to: r.addr, subject, text: body + footer };
        if (opts.html) payload.html = opts.html + (footer ? `<p style="margin-top:16px;color:#6b7280;font-size:12px">${esc(footer).replace(/\n/g, '<br>')}</p>` : '');
        if (replyTo) payload.reply_to = replyTo;
        const res = await fetch(RESEND_API_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const raw = await res.text();
        if (!res.ok) throw new Error(raw || `HTTP ${res.status}`);
      } else {
        const mailer = getMailer();
        if (!mailer) throw new Error('SMTP transporter unavailable');
        await mailer.sendMail({
          from: senderHeader, to: r.addr, subject, text: body + footer,
          html: opts.html ? opts.html + (footer ? `<p style="margin-top:16px;color:#6b7280;font-size:12px">${esc(footer).replace(/\n/g, '<br>')}</p>` : '') : undefined,
          replyTo: replyTo || undefined,
        });
      }
      sent++;
      await logEmailAttempt(db, { recipient: r.addr, subject, status: 'sent', sentAt: new Date(), provider: delivery.provider, senderName: delivery.senderName, senderEmail: delivery.senderEmail, replyToEmail: replyTo || null });
    } catch (e) {
      failed++; errors.push(e.message);
      await logEmailAttempt(db, { recipient: r.addr, subject, status: 'failed', sentAt: new Date(), errorMessage: e.message, provider: delivery.provider, senderName: delivery.senderName, senderEmail: delivery.senderEmail, replyToEmail: replyTo || null });
    }
  }
  return { ok: failed === 0, sent, failed, errors, provider: delivery.provider };
}

// Operator-facing email, deliberately separate from sendEmailEach: that one
// is tenant-scoped (it needs a churchId-bound db to write EmailLog rows and
// reads per-church EmailSetting). Infrastructure alerts belong to no church,
// so this writes no EmailLog and uses the process-level SMTP config only.
// Shares getMailer() and FORCE_DRY_RUN so it cannot send during tests.
async function sendOpsEmail(recipients, subject, body) {
  const to = (Array.isArray(recipients) ? recipients : String(recipients || '').split(','))
    .map((r) => String(r).trim()).filter(Boolean);
  if (!to.length) return { ok: false, reason: 'no recipients configured' };
  if (FORCE_DRY_RUN) return { ok: false, dryRun: true, reason: 'test runner' };
  const mailer = getMailer();
  if (!mailer) return { ok: false, reason: 'SMTP not configured (SMTP_HOST / SMTP_USER / SMTP_PASS)' };
  try {
    await mailer.sendMail({ from: SMTP_FROM, to: to.join(', '), subject, text: body });
    return { ok: true, sent: to.length };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

module.exports = { sendSmsBatch, smsDeliveryInfo, smsSenderFor, SENDER_ID_RE, sendEmailEach, normalizePhoneGH, emailDeliveryInfo, sendOpsEmail };
