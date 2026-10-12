#!/usr/bin/env node
'use strict';
// Manage platform operator accounts (lib/platform-operators.js). This script
// is the only way to create one; there is no sign-up page. Run it on the
// server, e.g. `fly ssh console`, then:
//
//   node scripts/platform-operator.js create you@example.com --name "Your Name"
//   node scripts/platform-operator.js list
//   node scripts/platform-operator.js reset-password you@example.com
//   node scripts/platform-operator.js reset-2fa you@example.com
//   node scripts/platform-operator.js disable you@example.com
//   node scripts/platform-operator.js enable you@example.com
//
// Passwords are typed at a hidden prompt. Without a terminal (piped or
// scripted), a strong random password is generated and printed once instead.
// Two-factor is set up by the operator at their first sign-in, at
// /platform/login. reset-password, reset-2fa and disable sign the operator
// out everywhere.

const crypto = require('crypto');
const readline = require('readline');
const { normalizeEnvDatabaseUrl } = require('../lib/database-url');

normalizeEnvDatabaseUrl();
const { db } = require('../lib/tenant');
const {
  hashOperatorPassword, revokeOperatorSessions, normEmail, MIN_PASSWORD_LENGTH,
} = require('../lib/platform-operators');

function usage(code = 1) {
  console.log(`Usage:
  node scripts/platform-operator.js create <email> [--name "Display Name"]
  node scripts/platform-operator.js list
  node scripts/platform-operator.js reset-password <email>
  node scripts/platform-operator.js reset-2fa <email>
  node scripts/platform-operator.js disable <email>
  node scripts/platform-operator.js enable <email>`);
  process.exit(code);
}

function hiddenPrompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); };
    rl.question(question, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
  });
}

// Prompt twice on a terminal; otherwise generate one and say so.
async function choosePassword() {
  if (!process.stdin.isTTY) {
    const generated = crypto.randomBytes(18).toString('base64url');
    console.log(`No terminal, so a password was generated. It is shown once; store it in a password manager now:\n\n  ${generated}\n`);
    return generated;
  }
  for (;;) {
    const first = await hiddenPrompt(`Password (at least ${MIN_PASSWORD_LENGTH} characters): `);
    if (first.length < MIN_PASSWORD_LENGTH) { console.log('Too short, try again.'); continue; }
    const second = await hiddenPrompt('Same password again: ');
    if (first !== second) { console.log('They did not match, try again.'); continue; }
    return first;
  }
}

async function findOrExit(email) {
  const operator = await db.platformOperator.findUnique({ where: { email: normEmail(email) } });
  if (!operator) { console.error(`No operator with email ${normEmail(email)}.`); process.exit(1); }
  return operator;
}

async function audit(operator, event) {
  await db.platformAuditLog.create({
    data: { operatorId: operator.id, operatorEmail: operator.email, event, subject: 'scripts/platform-operator.js' },
  });
}

async function main() {
  const [command, emailArg, ...rest] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h') usage(0);
  const email = normEmail(emailArg);
  if (command !== 'list' && !/^\S+@\S+\.\S+$/.test(email)) usage();

  if (command === 'list') {
    const rows = await db.platformOperator.findMany({ orderBy: { createdAt: 'asc' } });
    if (!rows.length) console.log('No platform operators yet.');
    for (const o of rows) {
      const state = o.disabledAt ? 'disabled' : o.totpEnabled ? '2FA on' : '2FA not set up yet';
      console.log(`${o.email}\t${o.displayName || ''}\t${state}\tlast sign-in ${o.lastLoginAt ? o.lastLoginAt.toISOString() : 'never'}`);
    }
    return;
  }

  if (command === 'create') {
    const nameAt = rest.indexOf('--name');
    const displayName = nameAt >= 0 ? String(rest[nameAt + 1] || '').trim() || null : null;
    if (await db.platformOperator.findUnique({ where: { email } })) {
      console.error(`An operator with email ${email} already exists.`);
      process.exit(1);
    }
    const passwordHash = await hashOperatorPassword(await choosePassword());
    const operator = await db.platformOperator.create({ data: { email, displayName, passwordHash } });
    await audit(operator, 'operator.created');
    console.log(`Created ${email}. Sign in at /platform/login; you will set up two-factor on the first sign-in.`);
    return;
  }

  const operator = await findOrExit(email);
  if (command === 'reset-password') {
    const passwordHash = await hashOperatorPassword(await choosePassword());
    await db.platformOperator.update({ where: { id: operator.id }, data: { passwordHash, failedAttempts: 0, lockedUntil: null } });
    await revokeOperatorSessions(operator.id);
    await audit(operator, 'operator.password_reset');
    console.log(`Password changed for ${email}. They have been signed out everywhere.`);
  } else if (command === 'reset-2fa') {
    await db.platformOperator.update({ where: { id: operator.id }, data: { totpEnabled: false, totpSecret: null, totpRecoveryCodes: null } });
    await revokeOperatorSessions(operator.id);
    await audit(operator, 'operator.mfa_reset');
    console.log(`Two-factor cleared for ${email}. They will set it up again at their next sign-in.`);
  } else if (command === 'disable') {
    await db.platformOperator.update({ where: { id: operator.id }, data: { disabledAt: new Date() } });
    await revokeOperatorSessions(operator.id);
    await audit(operator, 'operator.disabled');
    console.log(`${email} is disabled and signed out everywhere.`);
  } else if (command === 'enable') {
    await db.platformOperator.update({ where: { id: operator.id }, data: { disabledAt: null, failedAttempts: 0, lockedUntil: null } });
    await audit(operator, 'operator.enabled');
    console.log(`${email} is enabled again.`);
  } else {
    usage();
  }
}

main()
  .catch((e) => { console.error(e.message); process.exitCode = 1; })
  .finally(() => db.$disconnect());
