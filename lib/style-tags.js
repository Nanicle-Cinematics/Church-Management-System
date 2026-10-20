'use strict';
// One definition of "which stylesheets a page loads, in what order, with what
// cache-buster". Both HTML entry points use it: lib/shell.js (the app and auth
// shells) and lib/tenant-landing.js (the public marketing page, which builds
// its own document).
//
// It exists because those two drifted: the landing page linked styles.css with
// no version query at all, so returning visitors kept a stale copy after every
// deploy, and it missed the theme layer entirely when that was added.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Order matters: each sheet layers over the one before it and wins on source
// order. theme-precision.css re-skins the older layers and must come last.
const SHEETS = ['styles.css', 'theme-ios26.css', 'theme-precision.css'];

// Hashed once at module load — these files only change on deploy.
function cssVersion(file) {
  try {
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', file));
    return crypto.createHash('sha1').update(css).digest('hex').slice(0, 10);
  } catch (_) {
    return 'dev';
  }
}

// Page scripts live in public/js/ and load with defer. The Content-Security-
// Policy (lib/tenant-http.js) does not allow inline scripts or inline event
// handlers, so a page that needs behaviour loads a file here, passes any value
// it needs through a data- attribute, and asks for built-in behaviour (confirm,
// print, ...) with the data- attributes public/js/ui.js handles.
const scriptVersions = new Map();
function scriptTag(name, attrs = '') {
  if (!scriptVersions.has(name)) scriptVersions.set(name, cssVersion(`js/${name}.js`));
  return `<script src="/static/js/${name}.js?v=${scriptVersions.get(name)}" defer${attrs ? ' ' + attrs : ''}></script>`;
}
const UI_SCRIPT_TAG = scriptTag('ui');

const STYLE_TAGS = SHEETS
  .map((file) => `<link rel="stylesheet" href="/static/${file}?v=${cssVersion(file)}">`)
  .join('\n');

// The public pages (landing page and the signed-out shell) are
// self-contained: they load this one sheet INSTEAD of the app stylesheets,
// which keeps the front door light (about 20 KB of CSS, not 270 KB).
const PUBLIC_TAG = `<link rel="stylesheet" href="/static/public.css?v=${cssVersion('public.css')}">`;

// Light/dark for every page, run synchronously in <head> (before first paint)
// so a page never flashes the wrong theme. The choice is shared app-wide.
const APP_THEME_SCRIPT_TAG = `<script src="/static/app-theme.js?v=${cssVersion('app-theme.js')}"></script>`;

// Installable app: every page someone might install from (the app, the
// signed-out pages and the landing page) carries the manifest, the home-screen
// icon and public/pwa.js, which registers the service worker and offers
// "Install app". The theme colour paints the installed app's title bar.
//
// The manifest is per church (lib/app-icon.js), so it is requested with the
// session cookie. iPhones read the home-screen name and icon from these tags
// instead, so signed-in pages pass the church's (appIdentity()).
const attr = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
function pwaHeadTags({ title = 'Church Manager', appleIcon = '/static/apple-touch-icon.png' } = {}) {
  return [
    '<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials">',
    '<meta name="theme-color" content="#f6f6f8" media="(prefers-color-scheme: light)">',
    '<meta name="theme-color" content="#0b0b0f" media="(prefers-color-scheme: dark)">',
    `<link rel="apple-touch-icon" href="${attr(appleIcon)}">`,
    '<meta name="mobile-web-app-capable" content="yes">',
    '<meta name="apple-mobile-web-app-capable" content="yes">',
    `<meta name="apple-mobile-web-app-title" content="${attr(title)}">`,
    `<script src="/static/pwa.js?v=${cssVersion('pwa.js')}" defer></script>`,
  ].join('\n');
}
const PWA_HEAD_TAGS = pwaHeadTags();

module.exports = { STYLE_TAGS, PUBLIC_TAG, APP_THEME_SCRIPT_TAG, UI_SCRIPT_TAG, PWA_HEAD_TAGS, pwaHeadTags, scriptTag, SHEETS, cssVersion };
