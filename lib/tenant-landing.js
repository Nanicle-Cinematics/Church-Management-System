'use strict';
// Phase 8f: the public marketing landing page (unauthenticated GET /).
// Adapted, not a verbatim port — see the two real differences from the
// original (server.js's publicLandingPage):
// 1. CTAs link straight to /signup (already-built instant self-service
//    signup) instead of the original's /trial-signup lead-capture form
//    ("tell us your details, we'll email you"). That flow existed because
//    provisioning was a manual per-church deploy step in the old model;
//    here signup already creates a working church immediately, so a lead
//    form would be a strictly worse path to the same result.
// 2. Pricing is 2-tier (Free / Pro) matching the actual plan model
//    (routes-pg/settings.js's PLAN_LIMITS), not the original's stale
//    3-tier Starter/Pro/Enterprise copy with a monthly/yearly toggle that
//    has no corresponding billing system on this stack.
//
// Design system (styles.css, header/footer markup, section structure) is
// reused as-is from the original.

const { esc } = require('./format');
// Same stylesheets, order and cache-buster as every other page. This template
// previously hardcoded its own link, which is how it ended up serving
// unversioned CSS and missing the theme layer.
const { EDITORIAL_TAG, THEME_SCRIPT_TAG } = require('./style-tags');

// The PRODUCT name, deliberately NOT process.env.CHURCH_NAME.
//
// This page sells the product: it carries the Free/Pro pricing tiers and the
// /signup CTA that onboards new churches. It previously fell back to
// CHURCH_NAME, so setting that env var to a real church rebranded the title,
// header and footer of the signup funnel as that one customer's website —
// which is exactly backwards for the page whose job is to win the next
// customer. CHURCH_NAME is a per-deployment tenant name and still applies to
// signed-out pages that belong to a specific church (login, error and
// maintenance pages); it must not reach the marketing page.
const PRODUCT_NAME = 'Church Manager';

const THEME_INIT = THEME_SCRIPT_TAG;

const { MARK } = require('./brand');
const CHECK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3.2 3.2L13 4.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function landingPage(loggedIn) {
  const topCta = loggedIn ? { href: '/', label: 'Go to dashboard' } : { href: '/login', label: 'Sign in' };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(PRODUCT_NAME)} — the church office, in order</title>
<meta name="description" content="Members, attendance, giving and communication in one private workspace, with the approvals and audit trail your treasurer expects.">
${THEME_INIT}
${EDITORIAL_TAG}
</head>
<body class="ed-landing">
  <header class="ed-nav">
    <div class="ed-wrap">
      <a class="ed-wordmark" href="/">${MARK}${esc(PRODUCT_NAME)}</a>
      <nav aria-label="Main">
        <a href="#what">What it does</a>
        <a href="#accountability">Accountability</a>
        <a href="#pricing">Pricing</a>
        <a class="ed-btn quiet" href="${topCta.href}">${topCta.label}</a>
      </nav>
    </div>
  </header>

  <main>
    <section class="ed-hero">
      <div class="ed-wrap">
        <div>
          <p class="ed-eyebrow">Church administration</p>
          <h1>The church office, <em>in order.</em></h1>
          <p class="ed-lede">Members, attendance, giving and communication in one private workspace, with the approvals and audit trail your treasurer expects.</p>
          <div class="ed-cta">
            <a class="ed-btn" href="/signup">Create your church</a>
            <a class="ed-link" href="#what">See what it does</a>
          </div>
          <p class="ed-fine">Free for up to two users. No card required.</p>
        </div>
        <figure class="ed-ledger" aria-label="Sample service summary">
          <figcaption><span>Service summary</span><span>Sample data</span></figcaption>
          <h3>Sunday 5 July · Main sanctuary</h3>
          <dl>
            <div><dt>Attendance</dt><dd>386</dd></div>
            <div><dt>First-time visitors</dt><dd>14</dd></div>
            <div><dt>Offertory</dt><dd>GH₵ 4,210.00</dd></div>
            <div><dt>Tithes</dt><dd>GH₵ 9,865.50</dd></div>
            <div><dt>Building fund</dt><dd>GH₵ 1,500.00</dd></div>
            <div class="total"><dt>Total received</dt><dd>GH₵ 15,575.50</dd></div>
          </dl>
          <p class="seal">${CHECK} Counted by two people and verified</p>
        </figure>
      </div>
    </section>

    <section class="ed-proof" aria-label="Highlights">
      <div class="ed-wrap">
        <div><strong>Made for the church office</strong><span>For pastors, secretaries and treasurers, not accountants.</span></div>
        <div><strong>Cedis, day-borns, harvests</strong><span>Built around how Ghanaian churches actually give.</span></div>
        <div><strong>One private workspace</strong><span>Each church’s records are kept separate from every other’s.</span></div>
      </div>
    </section>

    <section id="what" class="ed-section">
      <div class="ed-wrap">
        <div class="ed-section-head">
          <h2>Everything the office does, in one place.</h2>
          <p>Replace the notebooks, spreadsheets and group chats with one record that everyone on the team can trust.</p>
        </div>
        <ol class="ed-rows">
          <li><span class="n">01</span><h3>Members</h3><p>Profiles, contacts, Bible classes and organizations, with a photo and an emergency contact on every record.</p></li>
          <li><span class="n">02</span><h3>Attendance and check-in</h3><p>Record services and events, or let people check themselves in by scanning a QR code at the door.</p></li>
          <li><span class="n">03</span><h3>Finance</h3><p>Offerings, tithes, pledges and expenses on a proper ledger, with receipts, payment vouchers, budgets and bank deposits.</p></li>
          <li><span class="n">04</span><h3>Communication</h3><p>Send announcements by SMS and email to everyone, to a group, or to one person, and see exactly who received them.</p></li>
          <li><span class="n">05</span><h3>Reports</h3><p>Income, day-born collections and membership trends, ready to print or export when the council asks.</p></li>
        </ol>
      </div>
    </section>

    <section id="accountability" class="ed-section">
      <div class="ed-wrap">
        <div class="ed-section-head">
          <h2>Built so the books can be checked.</h2>
          <p>Money in a church is held in trust. The system is designed so that no single person can quietly change the record.</p>
        </div>
        <ul class="ed-trust">
          <li><strong>Two people for every payout</strong><span>An expense must be approved by someone other than the person who recorded it, with higher limits needing a senior approver.</span></li>
          <li><strong>Counted, then verified</strong><span>Cash counts and bank deposits are signed off by a second officer before they reach the books.</span></li>
          <li><strong>Closed months stay closed</strong><span>Lock a period once it has been reviewed. Reopening it needs an administrator and a written reason.</span></li>
          <li><strong>A trail for everything</strong><span>Sign-ins, role changes and finance actions are recorded with who did them and when.</span></li>
        </ul>
      </div>
    </section>

    <section id="pricing" class="ed-section">
      <div class="ed-wrap">
        <div class="ed-section-head">
          <h2>Start free. Upgrade when you’re ready.</h2>
          <p>Try everything with your church’s own records before you decide.</p>
        </div>
        <div class="ed-plans">
          <article class="ed-plan">
            <h3>Free</h3>
            <div class="price">GH₵ 0</div>
            <p>The whole system for a small team.</p>
            <ul><li>Members, attendance and events</li><li>The full finance module</li><li>Up to 2 user accounts</li></ul>
            <a class="ed-btn" href="/signup">Create your church</a>
          </article>
          <article class="ed-plan">
            <h3>Pro</h3>
            <div class="price">Contact us</div>
            <p>For active churches with a larger office team.</p>
            <ul><li>Unlimited user accounts</li><li>Full reports</li><li>Priority support</li></ul>
            <a class="ed-btn quiet" href="/signup">Start free, upgrade later</a>
          </article>
        </div>
      </div>
    </section>
  </main>

  <footer class="ed-footer">
    <div class="ed-wrap">
      <div><strong>${esc(PRODUCT_NAME)}</strong><span>Less administration. More ministry.</span></div>
      <nav aria-label="Footer"><a href="#what">What it does</a><a href="#pricing">Pricing</a><a href="/login">Sign in</a><a href="/signup">Create your church</a></nav>
    </div>
  </footer>
</body>
</html>`;
}

module.exports = { landingPage };
