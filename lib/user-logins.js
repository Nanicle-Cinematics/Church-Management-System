'use strict';
// How staff sign in: an email, a phone number, or both (lib/phone.js), each
// unique across every church; and a username, unique within the church.
// Shared by the Users pages and the JSON API so create, edit and delete
// apply the same rules.

const { normalizePhone } = require('./phone');

/**
 * Read and check the email/phone fields of a form or JSON body.
 * Returns { email, phone } (email lower-cased or null, phone normalised or
 * null) or { error } with a message for the person filling the form.
 */
function parseLogins(body) {
  const email = typeof body.email === 'string' ? body.email.toLowerCase().trim() : '';
  const phoneInput = typeof body.phone === 'string' ? body.phone.trim() : '';
  const phone = phoneInput ? normalizePhone(phoneInput) : null;
  if (!email && !phoneInput) return { error: 'Give an email or a phone number for this user to sign in with.' };
  if (email && !/^\S+@\S+\.\S+$/.test(email)) return { error: 'That email does not look right.' };
  if (phoneInput && !phone) return { error: 'That phone number does not look right. Use a number like 024 412 7781 or +233 24 412 7781.' };
  return { email: email || null, phone };
}

/**
 * Is this email or phone already someone else's sign-in? Emails and phones are
 * unique across all churches, so the message says which case it is. Returns a
 * message, or null when both are free. `exceptId` is the user being edited.
 */
async function loginTakenMessage(rawDb, { email, phone }, churchId, exceptId = null) {
  for (const [field, value, noun] of [['email', email, 'email'], ['phone', phone, 'phone number']]) {
    if (!value) continue;
    const existing = await rawDb.user.findUnique({ where: { [field]: value } });
    if (!existing || existing.id === exceptId) continue;
    if (existing.churchId === churchId) {
      return existing.deletedAt ? `That ${noun} belonged to a user who was removed; use another ${noun}.` : `That ${noun} is already a user in your church. Find them in Users & Roles.`;
    }
    return `That ${noun} is already used by an account in another church. Each ${noun} can only have one account. Use a different ${noun}, or ask the platform operator to free it.`;
  }
  return null;
}

/** What a removed user's sign-in fields become, so they are free to reuse. */
function releasedOnDelete(user) {
  return {
    username: `deleted+${user.id}+${user.username}`,
    email: user.email ? `deleted+${user.id}+${user.email}` : null,
    phone: user.phone ? `deleted+${user.id}+${user.phone}` : null,
  };
}

/**
 * Usernames are unique within a church, and users removed before usernames
 * were released on delete still hold theirs. Free the name from any removed
 * user so it can be given to someone new. `db` is the church-scoped client.
 */
async function freeUsernameFromRemovedUsers(db, username) {
  const held = await db.user.findMany({ where: { username, deletedAt: { not: null } }, select: { id: true, username: true } });
  for (const u of held) await db.user.update({ where: { id: u.id }, data: { username: `deleted+${u.id}+${u.username}` } });
}

module.exports = { parseLogins, loginTakenMessage, releasedOnDelete, freeUsernameFromRemovedUsers };
