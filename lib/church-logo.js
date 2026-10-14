'use strict';
// Where each church's uploaded logo lives (Settings › Church logo). Shared by
// the settings routes, which upload and remove it, and lib/app-icon.js, which
// turns it into the installed app's icon.

const fs = require('fs');
const path = require('path');

const LOGO_DIR = process.env.LOGO_DIR || path.join(process.env.PHOTO_DIR || path.join(__dirname, '..', 'photos'), 'church-logos');
const LOGO_EXTENSIONS = ['png', 'jpg', 'webp', 'gif'];
try { fs.mkdirSync(LOGO_DIR, { recursive: true }); } catch (_) { /* created by the mounted volume at runtime */ }

function tenantLogoPath(churchId) {
  for (const ext of LOGO_EXTENSIONS) {
    const candidate = path.join(LOGO_DIR, `${churchId}.${ext}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function deleteTenantLogo(churchId) {
  for (const ext of LOGO_EXTENSIONS) {
    try { fs.unlinkSync(path.join(LOGO_DIR, `${churchId}.${ext}`)); } catch (_) { /* no file with this extension */ }
  }
}

module.exports = { LOGO_DIR, LOGO_EXTENSIONS, tenantLogoPath, deleteTenantLogo };
