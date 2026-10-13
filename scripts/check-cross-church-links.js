#!/usr/bin/env node
'use strict';
// Prints a read-only SQL query that counts, for every link between two
// church-owned tables, the rows that point at another church's row (for
// example a check-in in church A naming church B's member). Every count should
// be 0. Generated from prisma/schema.prisma so it covers each relation.
//
//   node scripts/check-cross-church-links.js > /tmp/check.sql
//   node scripts/check-cross-church-links.js --run     (uses DATABASE_URL)
//
// Paste the printed query into the Neon SQL Editor, or use --run.

const { Prisma } = require('@prisma/client');

const models = new Map(Prisma.dmmf.datamodel.models.map((m) => [m.name, m]));
const hasChurch = (m) => m.fields.some((f) => f.name === 'churchId' && f.kind === 'scalar');
const col = (model, field) => model.fields.find((f) => f.name === field).dbName || field;
const table = (m) => `"${m.dbName || m.name}"`;

const parts = [];
for (const child of models.values()) {
  if (!hasChurch(child)) continue;
  for (const f of child.fields) {
    if (f.kind !== 'object' || !f.relationFromFields || f.relationFromFields.length !== 1) continue;
    const parent = models.get(f.type);
    if (!parent || parent === undefined || !hasChurch(parent) || parent.name === 'Church') continue;
    const fk = col(child, f.relationFromFields[0]);
    const key = col(parent, (f.relationToFields && f.relationToFields[0]) || 'id');
    parts.push(`SELECT '${child.name}.${f.relationFromFields[0]} -> ${parent.name}' AS link, count(*) AS cross_church_rows
  FROM ${table(child)} c JOIN ${table(parent)} p ON p."${key}" = c."${fk}"
  WHERE c."${col(child, 'churchId')}" <> p."${col(parent, 'churchId')}"`);
  }
}
const sql = `${parts.join('\nUNION ALL\n')}\nORDER BY cross_church_rows DESC, link;\n`;

if (process.argv.includes('--run')) {
  const { db } = require('../lib/tenant');
  db.$queryRawUnsafe(sql)
    .then((rows) => {
      const bad = rows.filter((r) => Number(r.cross_church_rows) > 0);
      console.log(`${rows.length} links checked; ${bad.length} with cross-church rows.`);
      for (const r of bad) console.log(`  ${r.link}: ${r.cross_church_rows}`);
    })
    .catch((e) => { console.error(e.message); process.exitCode = 1; })
    .finally(() => db.$disconnect());
} else {
  process.stdout.write(sql);
}
