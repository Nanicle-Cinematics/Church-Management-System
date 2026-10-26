'use strict';
// The welcome screen shown for a few seconds right after someone signs in: the church's logo,
// big, with its name, and then the dashboard. It is a page of its own (not part of the app
// shell) so the logo has the whole screen. The animation is plain CSS (public/styles.css,
// "Welcome screen"); public/js/welcome.js only moves on to the dashboard when it ends, or at
// once on a tap, click or key. A <meta refresh> does the same if scripts cannot run.

const { esc } = require('./format');
const { STYLE_TAGS, APP_THEME_SCRIPT_TAG, scriptTag, PWA_HEAD_TAGS } = require('./style-tags');

const SHOW_MS = 3200;      // how long the screen stays
const REDUCED_MS = 1400;   // for people who ask their device for less motion

function welcomePage({ churchName, firstName = '', logoVersion = '', liturgical = null }) {
  const name = esc(churchName || 'Church Manager');
  return `<!doctype html>
<html lang="en"${liturgical ? ` data-liturgical="${esc(String(liturgical).toLowerCase())}"` : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Welcome · ${name}</title>
<meta http-equiv="refresh" content="${Math.ceil(SHOW_MS / 1000) + 3};url=/">
<meta name="robots" content="noindex">
${PWA_HEAD_TAGS || ''}
${APP_THEME_SCRIPT_TAG}
${STYLE_TAGS}
</head>
<body class="welcome-body">
<main class="welcome" id="welcome" data-ms="${SHOW_MS}" data-reduced-ms="${REDUCED_MS}" aria-label="Welcome to ${name}">
  <div class="welcome-rings" aria-hidden="true"><i></i><i></i><i></i></div>
  <div class="welcome-logo"><img src="/branding/logo${logoVersion ? `?v=${esc(logoVersion)}` : ''}" alt="${name} logo"></div>
  <h1 class="welcome-name">${name}</h1>
  <p class="welcome-hello">${firstName ? `Welcome, ${esc(firstName)}` : 'Welcome'}</p>
  <a class="welcome-skip" href="/">Continue</a>
</main>
${scriptTag('welcome')}
</body>
</html>`;
}

module.exports = { welcomePage, SHOW_MS, REDUCED_MS };
