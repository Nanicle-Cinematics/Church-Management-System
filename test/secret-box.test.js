'use strict';
const test = require('node:test');
const assert = require('node:assert');
const OTPAuth = require('otpauth');
const { seal, open } = require('../lib/secret-box');
const { createTotpSecret, verifyTotp } = require('../lib/mfa');

const codeFor = (secret) => new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();

test.beforeEach(() => { delete process.env.TOTP_ENCRYPTION_KEY; });
test.after(() => { delete process.env.TOTP_ENCRYPTION_KEY; });

test('with a key, a secret is stored encrypted and still verifies', () => {
  process.env.TOTP_ENCRYPTION_KEY = 'a-long-random-test-key';
  const { secret } = createTotpSecret('x');
  const stored = seal(secret);
  assert.match(stored, /^enc:v1:/);
  assert.ok(!stored.includes(secret), 'the plain secret must not appear in what is stored');
  assert.strictEqual(open(stored), secret);
  assert.strictEqual(verifyTotp(stored, codeFor(secret)), true);
  assert.strictEqual(seal(stored), stored, 'sealing twice does not double-encrypt');
  assert.notStrictEqual(seal(secret), seal(secret), 'each seal uses a fresh IV');
});

test('secrets stored before a key was set keep working, and no key means no change', () => {
  const { secret } = createTotpSecret('x');
  assert.strictEqual(seal(secret), secret, 'no key: stored as before');
  process.env.TOTP_ENCRYPTION_KEY = 'a-long-random-test-key';
  assert.strictEqual(verifyTotp(secret, codeFor(secret)), true, 'an old plaintext secret still verifies once a key is set');
});

test('a sealed secret that cannot be opened fails closed instead of throwing or passing', () => {
  process.env.TOTP_ENCRYPTION_KEY = 'key-one';
  const { secret } = createTotpSecret('x');
  const stored = seal(secret);
  process.env.TOTP_ENCRYPTION_KEY = 'key-two';
  assert.strictEqual(verifyTotp(stored, codeFor(secret)), false, 'wrong key');
  delete process.env.TOTP_ENCRYPTION_KEY;
  assert.strictEqual(verifyTotp(stored, codeFor(secret)), false, 'no key');
  process.env.TOTP_ENCRYPTION_KEY = 'key-one';
  assert.strictEqual(verifyTotp(stored.slice(0, -4) + 'AAAA', codeFor(secret)), false, 'tampered');
});
