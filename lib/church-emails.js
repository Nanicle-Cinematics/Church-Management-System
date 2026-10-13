'use strict';
// Login emails are unique across every church. When the platform deletes a
// church its users' rows stay (the delete is reversible for 30 days), so
// their emails would stay taken and nobody could sign up or be invited with
// them again. Deleting therefore renames each email to
// `released+<userId>+<email>`, which frees the original; restoring the church
// puts each one back unless another account has claimed it meanwhile.
// (Removing a single user does the same with a `deleted+` prefix.)

const PREFIX = 'released+';
const releasedEmail = (user) => `${PREFIX}${user.id}+${user.email}`;
const originalEmail = (user) => {
  const head = `${PREFIX}${user.id}+`;
  return user.email && user.email.startsWith(head) ? user.email.slice(head.length) : null;
};

/** Free every login email in a church. Returns how many were released. */
async function releaseChurchEmails(db, churchId) {
  const users = await db.user.findMany({ where: { churchId, email: { not: null } }, select: { id: true, email: true } });
  let released = 0;
  for (const u of users) {
    if (u.email.startsWith(PREFIX) || u.email.startsWith('deleted+')) continue;
    await db.user.update({ where: { id: u.id }, data: { email: releasedEmail(u) } });
    released++;
  }
  return released;
}

/**
 * Give a restored church's users their emails back. An email another account
 * has taken since stays released; those are returned so the operator can sort
 * them out.
 */
async function reclaimChurchEmails(db, churchId) {
  const users = await db.user.findMany({ where: { churchId, email: { startsWith: PREFIX } }, select: { id: true, email: true } });
  const taken = [];
  let restored = 0;
  for (const u of users) {
    const email = originalEmail(u);
    if (!email) continue;
    const clash = await db.user.findUnique({ where: { email }, select: { id: true } });
    if (clash) { taken.push(email); continue; }
    await db.user.update({ where: { id: u.id }, data: { email } });
    restored++;
  }
  return { restored, taken };
}

module.exports = { releaseChurchEmails, reclaimChurchEmails, originalEmail };
