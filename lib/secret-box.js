'use strict';
// Encrypts a stored secret (the authenticator-app seed) so a copy of the
// database alone cannot mint valid two-factor codes. AES-256-GCM, key from
// TOTP_ENCRYPTION_KEY (any long random string; set it with `fly secrets set`).
//
// Without a key, secrets are stored as before, and secrets that were stored
// before a key was set still read fine, so turning this on loses nobody.
// Sealed values start with "enc:v1:" so the two cannot be confused. If the
// key is later lost or changed, sealed secrets cannot be opened: those users
// fall back to their recovery codes, and an admin can reset their 2FA.

const crypto = require('crypto');

const PREFIX = 'enc:v1:';

function key() {
  const k = process.env.TOTP_ENCRYPTION_KEY;
  return k ? crypto.createHash('sha256').update(k).digest() : null;
}

function seal(text) {
  const k = key();
  if (!k || typeof text !== 'string' || !text || text.startsWith(PREFIX)) return text;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', k, iv);
  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return PREFIX + [iv, cipher.getAuthTag(), body].map((b) => b.toString('base64')).join('.');
}

/** Plain text for a stored value. Throws if it is sealed and cannot be opened. */
function open(value) {
  if (typeof value !== 'string' || !value.startsWith(PREFIX)) return value;
  const k = key();
  if (!k) throw new Error('A stored secret is encrypted but TOTP_ENCRYPTION_KEY is not set.');
  const [iv, tag, body] = value.slice(PREFIX.length).split('.').map((s) => Buffer.from(s, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', k, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

module.exports = { seal, open };
