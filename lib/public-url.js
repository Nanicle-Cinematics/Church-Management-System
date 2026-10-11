'use strict';
// Origin used in links we EMAIL (password reset, email verification).
//
// Falling back to the request's Host header would let anyone who can send a
// request choose the domain in a victim's reset email ("password reset
// poisoning"). In production PUBLIC_URL must therefore be set; without it we
// refuse to build the link and the caller skips sending.

function emailLinkBase(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '');
  if (process.env.NODE_ENV === 'production') return null;
  return `${req.protocol}://${req.get('host')}`;
}

module.exports = { emailLinkBase };
