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
// Styled by public/public.css (the Precision look, matching the signed-in
// app); the hero carries a miniature of the real dashboard.

const { esc } = require('./format');
// Same stylesheets, order and cache-buster as every other page. This template
// previously hardcoded its own link, which is how it ended up serving
// unversioned CSS and missing the theme layer.
const { PUBLIC_TAG, APP_THEME_SCRIPT_TAG, PWA_HEAD_TAGS } = require('./style-tags');

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


const { MARK_CROSS } = require('./brand');
const { icon } = require('./icons');

// Week-by-week bars for the hero's dashboard miniature (tithes, offerings, special).
const SAMPLE_WEEKS = [[58, 22, 3], [55, 21, 4], [61, 23, 2], [59, 22, 8], [64, 24, 3], [82, 25, 6], [62, 23, 5], [64, 24, 17], [61, 22, 6], [66, 25, 13], [85, 27, 22], [67, 24, 18]];

function landingPage(loggedIn) {
  const topCta = loggedIn ? { href: '/', label: 'Go to dashboard' } : { href: '/login', label: 'Sign in' };
  const tick = icon('check');
  const tallest = Math.max(...SAMPLE_WEEKS.map((w) => w[0] + w[1] + w[2]));
  const bars = SAMPLE_WEEKS.map(([a, b, c]) => `<span style="height:${((a + b + c) / tallest * 100).toFixed(1)}%"><i style="height:${a / (a + b + c) * 100}%"></i><i style="height:${b / (a + b + c) * 100}%"></i><i style="height:${c / (a + b + c) * 100}%"></i></span>`).join('');
  const feature = (ic, title, text, wide) => `<li${wide ? ' class="wide"' : ''}><i>${icon(ic)}</i><h3>${title}</h3><p>${text}</p></li>`;
  const trust = (title, text) => `<li><i>${tick}</i><div><strong>${title}</strong><span>${text}</span></div></li>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(PRODUCT_NAME)} — the church office, in order</title>
<meta name="description" content="Members, attendance, giving and communication in one private workspace, with the approvals and audit trail your treasurer expects.">
${PWA_HEAD_TAGS}
${APP_THEME_SCRIPT_TAG}
${PUBLIC_TAG}
</head>
<body class="pl">
  <header class="pl-nav">
    <div class="pu-wrap">
      <a class="pu-mark" href="/"><i>${MARK_CROSS}</i>${esc(PRODUCT_NAME)}</a>
      <nav aria-label="Main">
        <a href="#what">What it does</a>
        <a href="#accountability">Accountability</a>
        <a href="#pricing">Pricing</a>
        <a class="pu-btn ghost sm" href="${topCta.href}">${topCta.label}</a>
      </nav>
    </div>
  </header>

  <main>
    <section class="pl-hero">
      <div class="pu-wrap">
        <div>
          <p class="pl-eyebrow"><b>New</b> A cleaner, faster workspace</p>
          <h1>The church office, <em>in order.</em></h1>
          <p class="pl-lede">Members, attendance, giving and communication in one private workspace, with the approvals and audit trail your treasurer expects.</p>
          <div class="pl-cta">
            <a class="pu-btn" href="/signup">Create your church ${icon('arrowRight')}</a>
            <a class="pu-btn ghost" href="#what">See what it does</a>
          </div>
          <p class="pl-fine">Free for up to two users. No card required.</p>
        </div>
        <figure class="pl-shot" aria-label="A preview of the dashboard, with sample data" style="margin:0">
          <div class="pl-shot-bar"><i></i><i></i><i></i><span>Dashboard · sample data</span></div>
          <div class="pl-shot-body">
            <div class="pl-kpis">
              <div><small>Active members</small><b>1,284</b><em>↑ 2.4%</em></div>
              <div><small>Sunday attendance</small><b>742</b><em>↑ 4.0%</em></div>
              <div><small>Giving, October</small><b>GH₵ 34,850</b><em>↑ 9.8%</em></div>
            </div>
            <div class="pl-chart"><header><b>Giving</b><span>Last 12 weeks</span></header><div class="pl-bars" aria-hidden="true">${bars}</div></div>
            <div class="pl-rows">
              <div class="pl-mini"><h4>Needs attention</h4><p><i class="w">3</i>Expenses waiting for approval</p><p><i class="a">2</i>Cash counts to verify</p></div>
              <div class="pl-mini"><h4>Coming up</h4><p><i class="g">18</i>First Service · Sun 07:30</p><p><i class="a">21</i>Mid-week Bible Study</p></div>
            </div>
          </div>
        </figure>
      </div>
    </section>

    <section class="pl-proof" aria-label="Highlights">
      <div class="pu-wrap">
        <div><strong>Made for the church office</strong><span>For pastors, secretaries and treasurers, not accountants.</span></div>
        <div><strong>Cedis, day-borns, harvests</strong><span>Built around how Ghanaian churches actually give.</span></div>
        <div><strong>One private workspace</strong><span>Each church’s records are kept separate from every other’s.</span></div>
      </div>
    </section>

    <section id="what" class="pl-section">
      <div class="pu-wrap">
        <div class="pl-head">
          <p class="k">What it does</p>
          <h2>Everything the office does, in one place.</h2>
          <p>Replace the notebooks, spreadsheets and group chats with one record that everyone on the team can trust.</p>
        </div>
        <ul class="pl-features">
          ${feature('finance', 'Finance', 'Offerings, tithes, pledges and expenses on a proper ledger, with receipts, payment vouchers, budgets and bank deposits.', true)}
          ${feature('members', 'Members', 'Profiles, contacts, Bible classes and organizations, with a photo and an emergency contact on every record.')}
          ${feature('attendance', 'Attendance and check-in', 'Record services and events, or let people check themselves in by scanning a QR code at the door.')}
          ${feature('communications', 'Communication', 'Send announcements by SMS and email to everyone, to a group, or to one person, and see exactly who received them.')}
          ${feature('reports', 'Reports', 'Income, day-born collections and membership trends, ready to print or export when the council asks.')}
        </ul>
      </div>
    </section>

    <section id="accountability" class="pl-section" style="padding-top:0">
      <div class="pu-wrap">
        <div class="pl-head">
          <p class="k">Accountability</p>
          <h2>Built so the books can be checked.</h2>
          <p>Money in a church is held in trust. The system is designed so that no single person can quietly change the record.</p>
        </div>
        <ul class="pl-trust">
          ${trust('Two people for every payout', 'An expense must be approved by someone other than the person who recorded it, with higher limits needing a senior approver.')}
          ${trust('Counted, then verified', 'Cash counts and bank deposits are signed off by a second officer before they reach the books.')}
          ${trust('Closed months stay closed', 'Lock a period once it has been reviewed. Reopening it needs an administrator and a written reason.')}
          ${trust('A trail for everything', 'Sign-ins, role changes and finance actions are recorded with who did them and when.')}
        </ul>
      </div>
    </section>

    <section id="pricing" class="pl-section" style="padding-top:0">
      <div class="pu-wrap">
        <div class="pl-head">
          <p class="k">Pricing</p>
          <h2>Start free. Upgrade when you’re ready.</h2>
          <p>Try everything with your church’s own records before you decide.</p>
        </div>
        <div class="pl-plans">
          <article class="pl-plan pop">
            <h3>Free <b>Most churches start here</b></h3>
            <div class="price">GH₵ 0</div>
            <p>The whole system for a small team.</p>
            <ul><li>${tick}Members, attendance and events</li><li>${tick}The full finance module</li><li>${tick}Up to 2 user accounts</li></ul>
            <a class="pu-btn" href="/signup">Create your church</a>
          </article>
          <article class="pl-plan">
            <h3>Pro</h3>
            <div class="price">Contact us</div>
            <p>For active churches with a larger office team.</p>
            <ul><li>${tick}Unlimited user accounts</li><li>${tick}Full reports</li><li>${tick}Priority support</li></ul>
            <a class="pu-btn ghost" href="/signup">Start free, upgrade later</a>
          </article>
        </div>
      </div>
    </section>

    <section class="pl-section" style="padding-top:0">
      <div class="pu-wrap">
        <div class="pl-band">
          <div><h2>Less administration. More ministry.</h2><p>Set up your church in a few minutes.</p></div>
          <a class="pu-btn" href="/signup">Create your church ${icon('arrowRight')}</a>
        </div>
      </div>
    </section>
  </main>

  <footer class="pl-footer">
    <div class="pu-wrap">
      <div><strong style="color:var(--pu-text)">${esc(PRODUCT_NAME)}</strong><span>Less administration. More ministry.</span></div>
      <nav aria-label="Footer"><a href="#what">What it does</a><a href="#pricing">Pricing</a><a href="/login">Sign in</a><a href="/signup">Create your church</a></nav>
    </div>
  </footer>
</body>
</html>`;
}

module.exports = { landingPage };
