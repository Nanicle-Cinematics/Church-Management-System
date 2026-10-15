'use strict';
// Page frame for the platform console. Operators have no church, so the
// church shell (sidebar, New menu, phone tab bar) does not apply: a top bar
// with the console name, who is signed in, light/dark and sign out.
// Signed-out operator pages (sign-in, two-factor) use the shared authPage.

const { STYLE_TAGS, PUBLIC_TAG, APP_THEME_SCRIPT_TAG } = require('./style-tags');
const { MARK } = require('./brand');
const { esc } = require('./format');
const { flashHtml } = require('./views');
const { icon } = require('./icons');

// The console's sections, as tabs under the top bar.
const OP_NAV = [
  ['/platform', 'Overview'],
  ['/platform/payments', 'Payments'],
  ['/platform/sms', 'SMS'],
  ['/platform/health', 'Churches at risk'],
];

function operatorNav(active) {
  const current = active || '/platform';
  return `<nav class="pm-tabs op-tabs" aria-label="Console sections">${OP_NAV.map(([href, label]) => `<a href="${href}"${href === current ? ' aria-current="page"' : ''}>${esc(label)}</a>`).join('')}</nav>`;
}

function operatorLayout({ title, body, operator, flash, flashType, active }) {
  const who = operator ? (operator.displayName || operator.email) : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)} · Platform console</title>
${APP_THEME_SCRIPT_TAG}
${STYLE_TAGS}
</head>
<body class="pc pc-op">
<a class="skip-link" href="#main">Skip to content</a>
<div class="pc-app">
  <div class="pc-main">
    <header class="pc-top op-top">
      <a class="op-brand" href="/platform"><span class="op-mark">${MARK}</span><b>Platform console</b></a>
      <div class="pc-grow"></div>
      ${who ? `<span class="op-who" title="Signed in as ${esc(operator.email)}">${icon('lock')}<span>${esc(who)}</span></span>` : ''}
      <button class="pc-ib pc-theme" id="opTheme" type="button" aria-label="Switch between light and dark" title="Light / dark"><span class="moon">${icon('moon')}</span><span class="sun">${icon('sun')}</span></button>
      <form class="op-signout" method="post" action="/platform/logout"><button class="pc-ib sign-out" type="submit" aria-label="Sign out" title="Sign out">${icon('logout')}</button></form>
    </header>
    <main class="page" id="main" tabindex="-1">
      ${operator ? operatorNav(active) : ''}
      ${flashHtml(flash, flashType)}
      ${body}
    </main>
  </div>
</div>
<script>
  document.getElementById('opTheme').addEventListener('click', function () { if (window.AppTheme) AppTheme.toggle(); });
  document.querySelectorAll('.toast-x').forEach(function (b) { b.addEventListener('click', function () { b.closest('.toast').remove(); }); });
</script>
</body></html>`;
}

// Signed-out console pages (sign-in, two-factor, first-time setup). Plain on
// purpose: none of the church sign-in page's marketing panel.
function operatorAuthPage(title, body, { flash, flashType } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)} · Platform console</title>
${APP_THEME_SCRIPT_TAG}
${PUBLIC_TAG}
</head>
<body class="pa">
<div class="pa-grid op-auth">
  <main class="pa-main">
    <div class="pa-card">
      <p class="op-auth-mark"><span>${MARK}</span>Platform console</p>
      <h1>${esc(title)}</h1>
      ${flashHtml(flash, flashType)}
      ${body}
    </div>
  </main>
</div>
</body></html>`;
}

module.exports = { operatorLayout, operatorAuthPage };
