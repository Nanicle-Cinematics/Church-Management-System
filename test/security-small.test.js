'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { redactUrl } = require('../lib/redact-url');
const { imageExt, looksLikeImage } = require('../lib/format');

test('URLs that carry a secret in the path are redacted, and the query string is dropped', () => {
  assert.strictEqual(redactUrl('/reset-password/abc123def456'), '/reset-password/[redacted]');
  assert.strictEqual(redactUrl('/verify-email/abc123?next=/x'), '/verify-email/[redacted]');
  assert.strictEqual(redactUrl('/checkin/aabbccddeeff00112233445566778899'), '/checkin/[redacted]');
  assert.strictEqual(redactUrl('/rsvp/tok?ok=1'), '/rsvp/[redacted]');
  assert.strictEqual(redactUrl('/u/unsubscribe-token'), '/u/[redacted]');
  assert.strictEqual(redactUrl('https://x.example/reset-password/tok?a=b#c'), 'https://x.example/reset-password/[redacted]');
  assert.strictEqual(redactUrl('/members?q=Kwame+Mensah'), '/members', 'search text is dropped');
  assert.strictEqual(redactUrl('/finance/income'), '/finance/income', 'ordinary paths are untouched');
  assert.strictEqual(redactUrl(undefined), '');
});

test('the image type comes from the file\'s own bytes', () => {
  const pad = Buffer.alloc(16);
  assert.strictEqual(imageExt(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), pad])), 'jpg');
  assert.strictEqual(imageExt(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), pad])), 'png');
  assert.strictEqual(imageExt(Buffer.concat([Buffer.from('GIF89a'), pad])), 'gif');
  assert.strictEqual(imageExt(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), pad])), 'webp');
  assert.strictEqual(imageExt(Buffer.from('<html><script>alert(1)</script></html>')), null, 'markup claiming to be an image');
  assert.strictEqual(imageExt(Buffer.from('tiny')), null);
  assert.strictEqual(imageExt(null), null);
  assert.strictEqual(looksLikeImage(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), pad])), true);
  assert.strictEqual(looksLikeImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), false, 'SVG can carry script, so it is not accepted');
});
