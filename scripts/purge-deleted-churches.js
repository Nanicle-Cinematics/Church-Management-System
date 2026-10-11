#!/usr/bin/env node
'use strict';
// Permanently removes churches that an operator deleted (platform console) and
// whose 30-day grace period (Church.deletionPurgeAfter) has passed. Until now
// nothing ever acted on that date, so "deleted" churches were kept forever.
//
//   node scripts/purge-deleted-churches.js             # DRY RUN: lists what would go
//   node scripts/purge-deleted-churches.js --execute   # actually delete
//   node scripts/purge-deleted-churches.js --execute --church <id>   # one church
//
// Take a backup first (scripts/pg-backup.sh). This is irreversible.
// Deleting is done model by model in repeated passes: a model that still has
// rows referenced from another model fails with a foreign-key error (P2003) and
// is retried after its dependants are gone, so no hand-maintained order is needed.

const fs = require('fs');
const path = require('path');
const { Prisma } = require('@prisma/client');
const { db } = require('../lib/tenant');

const EXECUTE = process.argv.includes('--execute');
const ONLY = (() => { const i = process.argv.indexOf('--church'); return i > -1 ? process.argv[i + 1] : null; })();
const PHOTO_DIR = process.env.PHOTO_DIR || path.join(__dirname, '..', 'photos');
const LOGO_DIR = process.env.LOGO_DIR || path.join(PHOTO_DIR, 'church-logos');

const tenantModels = () => Prisma.dmmf.datamodel.models
  .filter((m) => m.fields.some((f) => f.name === 'churchId'))
  .map((m) => ({ name: m.name, delegate: m.name.charAt(0).toLowerCase() + m.name.slice(1) }));

async function counts(churchId) {
  const out = {};
  for (const { name, delegate } of tenantModels()) {
    const n = await db[delegate].count({ where: { churchId } });
    if (n) out[name] = n;
  }
  return out;
}

async function purge(church) {
  const members = await db.member.findMany({ where: { churchId: church.id, photoFilename: { not: null } }, select: { photoFilename: true } });
  const userIds = (await db.user.findMany({ where: { churchId: church.id }, select: { id: true } })).map((u) => String(u.id));

  const models = tenantModels();
  for (let pass = 1; pass <= 20; pass++) {
    let remaining = 0;
    let progressed = false;
    for (const { delegate } of models) {
      const before = await db[delegate].count({ where: { churchId: church.id } });
      if (!before) continue;
      try {
        await db[delegate].deleteMany({ where: { churchId: church.id } });
        progressed = true;
      } catch (e) {
        if (e.code !== 'P2003') throw e; // foreign key: retry next pass
        remaining += before;
      }
    }
    if (!remaining) break;
    if (!progressed) throw new Error(`Stuck: ${remaining} rows still referenced after pass ${pass}`);
  }

  // Sessions are keyed by user id inside the JSON payload.
  for (const id of userIds) {
    try { await db.$executeRawUnsafe(`DELETE FROM "session" WHERE sess ->> 'userId' = $1`, id); } catch (_) { /* no session table */ }
  }
  await db.church.delete({ where: { id: church.id } });

  for (const { photoFilename } of members) {
    try { fs.unlinkSync(path.join(PHOTO_DIR, path.basename(photoFilename))); } catch (_) { /* already gone */ }
  }
  for (const ext of ['png', 'jpg', 'webp', 'gif']) {
    try { fs.unlinkSync(path.join(LOGO_DIR, `${church.id}.${ext}`)); } catch (_) { /* none */ }
  }
}

async function main() {
  const due = await db.church.findMany({
    where: {
      deletedAt: { not: null },
      deletionPurgeAfter: { lte: new Date() },
      ...(ONLY ? { id: ONLY } : {}),
    },
    orderBy: { deletedAt: 'asc' },
  });
  if (!due.length) { console.log('No churches are past their purge date.'); return; }
  console.log(`${EXECUTE ? 'PURGING' : 'DRY RUN —'} ${due.length} church(es):`);
  for (const church of due) {
    console.log(`\n${church.name} (${church.slug}) id=${church.id} deleted ${church.deletedAt.toISOString().slice(0, 10)} — ${church.deletionReason || 'no reason'}`);
    console.log('  rows:', JSON.stringify(await counts(church.id)));
    if (EXECUTE) {
      await purge(church);
      console.log('  purged.');
    }
  }
  if (!EXECUTE) console.log('\nNothing was deleted. Re-run with --execute (after a backup) to purge.');
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => db.$disconnect());
