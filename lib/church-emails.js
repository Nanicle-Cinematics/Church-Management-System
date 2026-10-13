'use strict';
// Login emails and phone numbers are unique across every church. When the
// platform deletes a church its users' rows stay (the delete is reversible for
// 30 days), so their logins would stay taken and nobody could sign up or be
// invited with them again. Deleting therefore renames each one to
// `released+<userId>+<value>`, which frees the original; restoring the church
// puts each back unless another account has claimed it meanwhile.
// (Removing a single user does the same with a `deleted+` prefix.)

const PREFIX = 'released+';
const FIELDS = ['email', 'phone'];
const released = (user, field) => `${PREFIX}${user.id}+${user[field]}`;
const original = (user, field) => {
  const head = `${PREFIX}${user.id}+`;
  const v = user[field];
  return v && v.startsWith(head) ? v.slice(head.length) : null;
};
const isAlreadyFreed = (v) => v.startsWith(PREFIX) || v.startsWith('deleted+');

/** Free every login email and phone in a church. Returns how many were released. */
async function releaseChurchEmails(db, churchId) {
  const users = await db.user.findMany({ where: { churchId }, select: { id: true, email: true, phone: true } });
  let count = 0;
  for (const u of users) {
    const data = {};
    for (const f of FIELDS) if (u[f] && !isAlreadyFreed(u[f])) data[f] = released(u, f);
    if (!Object.keys(data).length) continue;
    await db.user.update({ where: { id: u.id }, data });
    count += Object.keys(data).length;
  }
  return count;
}

/**
 * Give a restored church's users their emails and phones back. One another
 * account has taken since stays released; those are returned so the operator
 * can sort them out.
 */
async function reclaimChurchEmails(db, churchId) {
  const users = await db.user.findMany({
    where: { churchId, OR: FIELDS.map((f) => ({ [f]: { startsWith: PREFIX } })) },
    select: { id: true, email: true, phone: true },
  });
  const taken = [];
  let restored = 0;
  for (const u of users) {
    const data = {};
    for (const f of FIELDS) {
      const value = original(u, f);
      if (!value) continue;
      const clash = await db.user.findUnique({ where: { [f]: value }, select: { id: true } });
      if (clash) taken.push(value); else data[f] = value;
    }
    if (!Object.keys(data).length) continue;
    await db.user.update({ where: { id: u.id }, data });
    restored += Object.keys(data).length;
  }
  return { restored, taken };
}

module.exports = { releaseChurchEmails, reclaimChurchEmails };
