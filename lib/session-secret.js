'use strict';
// One place that decides the secret used to sign session cookies and the
// public check-in "pick" tokens.
//
// Previously tenant-http.js fell back to the literal 'dev-only-secret' even in
// production, while server.js logged that it was "generating an ephemeral
// one" — it was not. A known signing key is a real weakness, so in production
// a missing SESSION_SECRET now yields a random per-process secret (logins are
// lost on restart, exactly as the startup warning always claimed). Outside
// production the fixed dev value is kept so local restarts keep sessions.

const crypto = require('crypto');

let ephemeral = null;

function getSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (process.env.NODE_ENV !== 'production') return 'dev-only-secret';
  if (!ephemeral) ephemeral = crypto.randomBytes(32).toString('hex');
  return ephemeral;
}

module.exports = { getSessionSecret };
