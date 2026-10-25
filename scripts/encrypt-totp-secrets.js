'use strict';
// One-off: encrypt the authenticator secrets stored before TOTP_ENCRYPTION_KEY
// was set (lib/secret-box.js). Safe to run twice: already-encrypted rows are
// skipped. Run it once after setting the key:
//   fly ssh console -a church-management-system -C "node scripts/encrypt-totp-secrets.js"
// (or locally with DATABASE_URL and TOTP_ENCRYPTION_KEY set).

const { db } = require('../lib/tenant');
const { seal } = require('../lib/secret-box');

async function encryptAll(model, label) {
  const rows = await model.findMany({ where: { totpSecret: { not: null } }, select: { id: true, totpSecret: true } });
  let done = 0;
  for (const row of rows) {
    const sealed = seal(row.totpSecret);
    if (sealed === row.totpSecret) continue;
    await model.update({ where: { id: row.id }, data: { totpSecret: sealed } });
    done++;
  }
  console.log(`${label}: ${done} of ${rows.length} secret(s) encrypted`);
}

(async () => {
  if (!process.env.TOTP_ENCRYPTION_KEY) throw new Error('Set TOTP_ENCRYPTION_KEY first.');
  await encryptAll(db.user, 'church users');
  await encryptAll(db.platformOperator, 'platform operators');
  await db.$disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });
