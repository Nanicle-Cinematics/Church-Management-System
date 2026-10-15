'use strict';
// The marketing site's "Request demo" form (marketing/index.html) posts here.
// Each enquiry becomes a TrialSignup row for Platform › Trial enquiries, and
// the operators get an email about it (ALERT_EMAIL / PLATFORM_ADMIN_EMAILS).
//
// It is a public, session-less form posted from another site, so it skips the
// CSRF check (lib/tenant-csrf.js) like QR check-in does. Spam is held back by
// a hidden "website" field people never fill in (filled = quietly dropped)
// and a limit of 5 enquiries an hour per address.

const asyncHandler = require('../lib/async-handler');
const { esc } = require('../lib/format');
const { db: rawDb } = require('../lib/tenant');
const { createRateLimiter } = require('../lib/rate-limit');
const { sendOpsEmail } = require('../lib/delivery');
const { authPage } = require('../lib/tenant-shell');

const enquiryRateLimit = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 5, key: (req) => req.ip });
const SIZES = ['Under 100', '100 – 300', '300 – 1,000', 'Over 1,000'];
const field = (v, max) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, max);

// Back to the site the form was on: the Referer's origin (browsers send at
// least that cross-site), else nothing.
function backLink(req) {
  try {
    const url = new URL(String(req.get('referer') || ''));
    if (url.protocol === 'https:' || url.hostname === 'localhost') return `<p><a class="btn" href="${esc(url.origin)}/">Back to the website</a></p>`;
  } catch (_) { /* no or bad Referer */ }
  return '';
}
const thanksPage = (req, message) => authPage('Thank you', `<p>${message}</p>${backLink(req)}`);

function register(app) {
  app.post('/enquiry', enquiryRateLimit, asyncHandler(async (req, res) => {
    const b = req.body || {};
    if (field(b.website, 200)) return res.send(thanksPage(req, 'We have your request and will be in touch.')); // a bot
    const enquiry = {
      contactName: field(b.name, 120),
      churchName: field(b.church, 160),
      role: field(b.role, 80) || null,
      phone: field(b.phone, 40),
      email: field(b.email, 160) || null,
      memberCount: SIZES.includes(field(b.size, 40)) ? field(b.size, 40) : null,
      notes: [
        field(b.denomination, 80) && `Denomination: ${field(b.denomination, 80)}`,
        field(b.city, 80) && `City: ${field(b.city, 80)}`,
        String(b.notes || '').replace(/\r\n?/g, '\n').trim().slice(0, 2000), // keeps its lines
      ].filter(Boolean).join('\n') || null,
    };
    if (!enquiry.contactName || !enquiry.churchName || !enquiry.phone.replace(/\D/g, '')) {
      return res.status(400).send(authPage('Almost there', `<p class="error">Please give your name, your church's name and a phone number.</p>${backLink(req)}`));
    }
    const row = await rawDb.trialSignup.create({ data: { ...enquiry, status: 'new' } });

    const to = process.env.ALERT_EMAIL || process.env.PLATFORM_ADMIN_EMAILS || '';
    if (to) {
      const base = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
      const text = [
        `${enquiry.contactName}${enquiry.role ? ` (${enquiry.role})` : ''} at ${enquiry.churchName} asked for a demo.`,
        `Phone: ${enquiry.phone}`, enquiry.email && `Email: ${enquiry.email}`, enquiry.memberCount && `Members: ${enquiry.memberCount}`,
        enquiry.notes && `\n${enquiry.notes}`, base && `\nTrial enquiries: ${base}/platform/trials#t${row.id}`,
      ].filter(Boolean).join('\n');
      sendOpsEmail(to, `Demo request: ${enquiry.churchName}`, text)
        .catch((e) => console.error('[enquiry] email failed:', e.message));
    }
    res.send(thanksPage(req, `Thank you, ${esc(enquiry.contactName)}. We have your request for ${esc(enquiry.churchName)} and will call or message you shortly.`));
  }));
}

module.exports = { register };
