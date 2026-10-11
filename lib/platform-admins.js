'use strict';
// PLATFORM_ADMIN_EMAILS is an allowlist of operator accounts that can see and
// suspend EVERY church. Access is granted by email match alone, so an address
// on the list that nobody has registered yet is a standing invitation: anyone
// could sign up with it (email verification is off by default) and become the
// platform operator. Registration of listed addresses is therefore closed off
// except for the very first signup on an empty install (see lib/provision.js).

function platformAdminEmails() {
  return String(process.env.PLATFORM_ADMIN_EMAILS || '')
    .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
}

function isPlatformAdminEmail(email) {
  return platformAdminEmails().includes(String(email || '').trim().toLowerCase());
}

module.exports = { platformAdminEmails, isPlatformAdminEmail };
