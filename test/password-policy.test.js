'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { passwordProblem } = require('../lib/password-policy');

test('too short is refused, with the length in the message', () => {
  assert.match(passwordProblem('Short1!'), /at least 10/);
  assert.match(passwordProblem(''), /at least 10/);
  assert.match(passwordProblem(undefined), /at least 10/);
  assert.match(passwordProblem(12345678901), /at least 10/, 'a number is not a password');
});

test('common passwords are refused however they are dressed up', () => {
  for (const pw of ['password123', 'Password1234!', 'PASSWORD2024', 'qwertyuiop', 'Welcome2024!', 'letmein12345', 'Methodist123', 'church-2025', 'Passw0rd12345']) {
    assert.match(passwordProblem(pw), /too easy to guess/, pw);
  }
});

test('one repeated character and all-digit passwords are refused', () => {
  assert.match(passwordProblem('aaaaaaaaaaaa'), /too easy/);
  assert.match(passwordProblem('1234567890'), /too easy/);
  assert.match(passwordProblem('0123456789012'), /too easy/);
});

test('a password containing the email name is refused', () => {
  assert.match(passwordProblem('kwamemensah-2026', { email: 'kwamemensah@example.com' }), /email name/);
  assert.strictEqual(passwordProblem('a-different-phrase-9', { email: 'kwamemensah@example.com' }), null);
  assert.strictEqual(passwordProblem('abc-xyz-1234', { email: 'abc@example.com' }), null, 'a very short name is not matched');
});

test('ordinary strong passwords and passphrases pass', () => {
  for (const pw of ['Tr0ubadour-7!', 'correct horse battery', 'grace-and-mercy-4ever', 'Zq9#mWp2$Lx8']) {
    assert.strictEqual(passwordProblem(pw), null, pw);
  }
});
