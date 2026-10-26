'use strict';
// The welcome screen's colours: taken from the church's own logo (its most vivid colour),
// or a colour the admin chose in Settings. A colour becomes three stops (deep, middle,
// bright) for the background, all dark enough for the white church name on top.

const fs = require('fs');
const sharp = require('sharp');
const { tenantLogoPath } = require('./church-logo');

const HEX = /^#[0-9a-f]{6}$/i;

function hexToRgb(hex) { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
const toHex = (rgb) => `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;

function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b); const min = Math.min(r, g, b); const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
function hslToRgb([h, s, l]) {
  const c = (1 - Math.abs(2 * l - 1)) * s; const x = c * (1 - Math.abs(((h / 60) % 2) - 1)); const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}
function luminance([r, g, b]) {
  const c = [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
/** WCAG contrast of white text on this colour. */
const whiteContrast = (rgb) => 1.05 / (luminance(rgb) + 0.05);

/**
 * Three stops of one hue: deep, middle and bright. The deep and middle stops are darkened until
 * white text reads on them (4.5:1); the bright stop is only a glow and may be lighter.
 */
function palette(hex) {
  if (!HEX.test(String(hex || ''))) return null;
  const [h, s0] = rgbToHsl(hexToRgb(hex));
  const s = s0 < 0.1 ? s0 : Math.min(0.85, Math.max(0.35, s0)); // a grey stays grey
  const stop = (l) => {
    let light = l;
    let rgb = hslToRgb([h, s, light]);
    while (whiteContrast(rgb) < 4.5 && light > 0.08) { light -= 0.02; rgb = hslToRgb([h, s, light]); }
    return toHex(rgb);
  };
  return { deep: stop(0.2), mid: stop(0.34), bright: toHex(hslToRgb([h, s, 0.5])) };
}

/** The most vivid colour in an image: bucketed pixels, near-white, grey and transparent ones ignored. */
async function dominantColour(file) {
  const { data, info } = await sharp(file, { pages: 1, limitInputPixels: 50e6 })
    .resize(64, 64, { fit: 'inside' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const buckets = new Map();
  for (let i = 0; i < data.length; i += info.channels) {
    const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
    if (a < 128) continue;
    const [, s, l] = rgbToHsl([r, g, b]);
    if (l > 0.92 || l < 0.08 || s < 0.25) continue; // paper, ink and greys are not a brand colour
    const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
    const e = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0, score: 0 };
    e.n += 1; e.r += r; e.g += g; e.b += b; e.score += 0.4 + s;
    buckets.set(key, e);
  }
  let best = null;
  for (const e of buckets.values()) if (!best || e.score > best.score) best = e;
  return best ? toHex([best.r / best.n, best.g / best.n, best.b / best.n]) : null;
}

const cache = new Map(); // churchId -> { stamp, colour }
/** The church's logo colour, or null (no custom logo, or a logo with no colour in it). Cached per logo file. */
async function logoColour(churchId) {
  const file = tenantLogoPath(churchId);
  if (!file) return null;
  try {
    const st = fs.statSync(file);
    const stamp = `${st.mtimeMs}:${st.size}`;
    const hit = cache.get(churchId);
    if (hit && hit.stamp === stamp) return hit.colour;
    const colour = await dominantColour(file);
    cache.set(churchId, { stamp, colour });
    return colour;
  } catch (_) { return null; }
}

/** The palette for a church: the colour its admin chose, else its logo's, else null (the app's own accent). */
async function welcomePalette(churchId, chosen) {
  return palette(HEX.test(String(chosen || '')) ? chosen : await logoColour(churchId));
}

module.exports = { HEX, palette, dominantColour, logoColour, welcomePalette, whiteContrast, hexToRgb };
