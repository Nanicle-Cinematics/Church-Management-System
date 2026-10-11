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
// order. theme-material.css re-skins the glass theme and must come last.
const SHEETS = ['styles.css', 'theme-ios26.css', 'theme-material.css'];

// Hashed once at module load — these files only change on deploy.
function cssVersion(file) {
  try {
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', file));
    return crypto.createHash('sha1').update(css).digest('hex').slice(0, 10);
  } catch (_) {
    return 'dev';
  }
}

const STYLE_TAGS = SHEETS
  .map((file) => `<link rel="stylesheet" href="/static/${file}?v=${cssVersion(file)}">`)
  .join('\n');

// The editorial theme (public landing page and the sign-in shell) is
// self-contained: pages that use it load this one sheet INSTEAD of the app
// stylesheets, which keeps the front door light (about 15 KB of CSS, not 270 KB).
const EDITORIAL_TAG = `<link rel="stylesheet" href="/static/editorial.css?v=${cssVersion('editorial.css')}">`;

// The palette/theme engine. It runs synchronously in <head> (before first paint)
// so the page never flashes the wrong colours.
const THEME_SCRIPT_TAG = `<script src="/static/material-theme.js?v=${cssVersion('material-theme.js')}"></script>`;

module.exports = { STYLE_TAGS, EDITORIAL_TAG, THEME_SCRIPT_TAG, SHEETS, cssVersion };
