'use strict';
// The installed app's name and icon, per church. Signed out, it is the
// product's (public/manifest.webmanifest and the icons beside it). Signed in,
// the app carries the church's name, and its logo when it has uploaded one
// (Settings › Church logo).
//
// A logo can be any shape, size or format the upload takes, so it is drawn
// onto square white PNGs: with a margin for ordinary icons, and smaller for
// "maskable" ones, which Android crops to a circle or squircle.
//
// Icon URLs name the church and the logo's version and carry an HMAC. They
// work without a session (Android builds its home-screen app from them, and
// browsers do not always send cookies for manifest icons), but cannot be
// guessed to fetch another church's logo. A new logo means new URLs, so a
// URL's image can be cached for good.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { tenantLogoPath } = require('./church-logo');
const { getSessionSecret } = require('./session-secret');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const BASE_MANIFEST = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, 'manifest.webmanifest'), 'utf8'));
const DEFAULT_APPLE_ICON = '/static/apple-touch-icon.png';

// variant -> [size, maskable, the product icon to use without a logo]
const VARIANTS = {
  180: [180, false, 'apple-touch-icon.png'],
  192: [192, false, 'icon-192.png'],
  512: [512, false, 'icon-512.png'],
  'maskable-192': [192, true, 'icon-192.png'],
  'maskable-512': [512, true, 'icon-512.png'],
};

function sign(churchId, version) {
  return crypto.createHmac('sha256', getSessionSecret()).update(`app-icon:${churchId}:${version}`).digest('base64url').slice(0, 22);
}

// Changes whenever the logo is replaced; null when the church has none.
function logoVersion(churchId) {
  const file = churchId ? tenantLogoPath(churchId) : null;
  if (!file) return null;
  try { return Math.floor(fs.statSync(file).mtimeMs).toString(36); } catch (_) { return null; }
}

function iconUrl(churchId, version, variant) {
  return `/branding/app-icon/${encodeURIComponent(churchId)}/${version}/${sign(churchId, version)}/${variant}.png`;
}

// Home-screen labels are cut off after about 12–15 characters, so a long
// name is shortened at a comma ("Dunwell Methodist Society, Koforidua"), then
// at a word.
function shortName(name) {
  const full = String(name || '').trim();
  if (!full) return BASE_MANIFEST.short_name;
  if (full.length <= 15) return full;
  const head = full.split(',')[0].trim();
  if (head.length <= 15) return head;
  let out = '';
  for (const word of head.split(/\s+/)) {
    if ((out ? out.length + 1 : 0) + word.length > 15) break;
    out = out ? `${out} ${word}` : word;
  }
  return out || head.slice(0, 15);
}

// For the page <head> (lib/style-tags.js pwaHeadTags): iPhones take the
// home-screen name and icon from there rather than from the manifest.
function appIdentity(church) {
  if (!church || !church.id) return { title: BASE_MANIFEST.short_name, appleIcon: DEFAULT_APPLE_ICON };
  const version = logoVersion(church.id);
  return {
    title: shortName(church.name),
    appleIcon: version ? iconUrl(church.id, version, '180') : DEFAULT_APPLE_ICON,
  };
}

function manifestFor(church) {
  if (!church || !church.id) return BASE_MANIFEST;
  const version = logoVersion(church.id);
  const icons = version
    ? [192, 512].flatMap((size) => [
      { src: iconUrl(church.id, version, String(size)), sizes: `${size}x${size}`, type: 'image/png', purpose: 'any' },
      { src: iconUrl(church.id, version, `maskable-${size}`), sizes: `${size}x${size}`, type: 'image/png', purpose: 'maskable' },
    ])
    : BASE_MANIFEST.icons;
  const shortcutIcon = [{ src: icons[0].src, sizes: '192x192' }];
  return {
    ...BASE_MANIFEST,
    name: church.name || BASE_MANIFEST.name,
    short_name: shortName(church.name),
    icons,
    shortcuts: BASE_MANIFEST.shortcuts.map((s) => ({ ...s, icons: shortcutIcon })),
  };
}

// Rendered icons, newest last; a church has at most five, and few churches
// install at once, so a small cap is plenty.
const rendered = new Map();
const MAX_RENDERED = 100;

async function renderIcon(churchId, version, variant) {
  const key = `${churchId}:${version}:${variant}`;
  if (rendered.has(key)) return rendered.get(key);
  const [size, maskable] = VARIANTS[variant];
  const inner = Math.round(size * (maskable ? 0.62 : 0.84));
  const logo = await sharp(tenantLogoPath(churchId), { pages: 1, limitInputPixels: 50e6 })
    .rotate() // honour a photo's EXIF orientation
    .resize(inner, inner, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } })
    .png()
    .toBuffer();
  const png = await sharp({ create: { width: size, height: size, channels: 4, background: '#ffffff' } })
    .composite([{ input: logo, gravity: 'centre' }])
    .png()
    .toBuffer();
  rendered.set(key, png);
  if (rendered.size > MAX_RENDERED) rendered.delete(rendered.keys().next().value);
  return png;
}

// GET /branding/app-icon/:churchId/:version/:sig/:variant.png
async function serveAppIcon(req, res) {
  const { churchId, version, sig, variant } = req.params;
  const expected = sign(churchId, version);
  if (!Object.hasOwn(VARIANTS, variant) || sig.length !== expected.length
    || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return res.status(404).send('Not found');
  }
  const fallback = () => {
    res.set('Cache-Control', 'public, max-age=86400');
    res.sendFile(path.join(PUBLIC_DIR, VARIANTS[variant][2]));
  };
  // An installed app keeps old URLs until the browser re-reads the manifest:
  // after the logo is replaced they show the new one, after it is removed,
  // the product icon. Only the current version may be cached for good.
  const current = logoVersion(churchId);
  if (!current) return fallback();
  try {
    const png = await renderIcon(churchId, current, variant);
    res.set('Cache-Control', current === version ? 'public, max-age=31536000, immutable' : 'public, max-age=3600');
    res.type('png').send(png);
  } catch (err) {
    console.warn(`[app-icon] could not draw church ${churchId}'s logo: ${err.message}`);
    fallback();
  }
}

module.exports = { appIdentity, manifestFor, serveAppIcon, shortName };
