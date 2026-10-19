'use strict';
// Some URLs carry a secret in the path: the password-reset and email-verify
// links, the check-in and RSVP links, the unsubscribe link. Anything that
// records a URL (the error log, Sentry) must not keep them: a reset link is
// a working credential until it is used or expires. The query string goes
// too, since it can hold search text and names.

const TOKEN_PATHS = /\/(reset-password|verify-email|checkin|rsvp|u)\/[^/?#]+/g;

function redactUrl(url) {
  return String(url || '').split(/[?#]/)[0].replace(TOKEN_PATHS, '/$1/[redacted]');
}

module.exports = { redactUrl };
