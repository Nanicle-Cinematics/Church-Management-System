'use strict';
// The welcome screen shown for a few seconds right after someone signs in: the church's logo,
// big, with its name, in the church's own colours, and then the dashboard. It is a page of its
// own (not part of the app shell) so the logo has the whole screen. The movement is plain CSS
// (public/styles.css, "Welcome screen"), one style per church (Settings › Welcome animation);
// public/js/welcome.js only moves on to the next page when it ends, or at once on a tap, click
// or key. A <meta refresh> does the same if scripts cannot run.

const { esc } = require('./format');
const { STYLE_TAGS, APP_THEME_SCRIPT_TAG, scriptTag, PWA_HEAD_TAGS } = require('./style-tags');

const SHOW_MS = 3200;      // how long the screen stays
const REDUCED_MS = 1400;   // for people who ask their device for less motion

const STYLES = {
  pop: ['Pop and rings', 'Bold and lively: the logo pops in and rings spread out behind it.'],
  rise: ['Gentle rise', 'Calm: the logo fades up slowly.'],
  reveal: ['Circle reveal', 'The logo opens like a lens, and the name slides in.'],
  sunburst: ['Sunburst', 'Rays turn behind a logo that drops in with a bounce.'],
};
const DEFAULT_STYLE = 'pop';
// Where the screen goes on to: a page of this app, never another site ("//host", a backslash or a full URL fall back to the dashboard).
const LOCAL_PATH = /^\/(?![/\\])[^\s\\<>"']{0,300}$/;
const safeNext = (v) => (typeof v === 'string' && LOCAL_PATH.test(v) && !v.startsWith('/welcome') ? v : '/');
const styleOf = (v) => (Object.prototype.hasOwnProperty.call(STYLES, v) ? v : DEFAULT_STYLE);

/**
 * palette: { deep, mid, bright } from lib/welcome-colours.js, or null for the app's own accent.
 * next: where it goes on to (the dashboard; Settings when an admin is previewing).
 */
function welcomePage({ churchName, firstName = '', logoVersion = '', liturgical = null, style = DEFAULT_STYLE, palette = null, next = '/' }) {
  const name = esc(churchName || 'Church Manager');
  const kind = styleOf(style);
  const vars = palette ? ` style="--w1:${esc(palette.deep)};--w2:${esc(palette.mid)};--w3:${esc(palette.bright)}"` : '';
  const nextUrl = safeNext(next);
  return `<!doctype html>
<html lang="en"${liturgical ? ` data-liturgical="${esc(String(liturgical).toLowerCase())}"` : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Welcome · ${name}</title>
<meta http-equiv="refresh" content="${Math.ceil(SHOW_MS / 1000) + 3};url=${esc(nextUrl)}">
<meta name="robots" content="noindex">
${PWA_HEAD_TAGS || ''}
${APP_THEME_SCRIPT_TAG}
${STYLE_TAGS}
</head>
<body class="welcome-body">
<main class="welcome welcome-${kind}" id="welcome" data-ms="${SHOW_MS}" data-reduced-ms="${REDUCED_MS}" data-next="${esc(nextUrl)}"${vars} aria-label="Welcome to ${name}">
  ${kind === 'pop' ? '<div class="welcome-rings" aria-hidden="true"><i></i><i></i><i></i></div>' : ''}${kind === 'sunburst' ? '<div class="welcome-rays" aria-hidden="true"></div>' : ''}
  <div class="welcome-logo"><img src="/branding/logo${logoVersion ? `?v=${esc(logoVersion)}` : ''}" alt="${name} logo"></div>
  <h1 class="welcome-name">${name}</h1>
  <p class="welcome-hello">${firstName ? `Welcome, ${esc(firstName)}` : 'Welcome'}</p>
  <a class="welcome-skip" href="${esc(nextUrl)}">Continue</a>
</main>
${scriptTag('welcome')}
</body>
</html>`;
}

module.exports = { welcomePage, SHOW_MS, REDUCED_MS, STYLES, DEFAULT_STYLE, styleOf, safeNext };
