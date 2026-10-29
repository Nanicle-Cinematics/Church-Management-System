'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { buildVersion } = require('../lib/build-version');
const { createTenantApp } = require('../lib/tenant-http');

const SHA = '6f149e0c8d2b4a1e9f0a7b3c5d6e8f9a0b1c2d3e';

test('buildVersion reads the commit or Fly deployment label from FLY_IMAGE_REF', () => {
  assert.deepStrictEqual(
    buildVersion({ FLY_IMAGE_REF: `registry.fly.io/church-management-system:${SHA}` }),
    { commit: '6f149e0' },
  );
  assert.deepStrictEqual(
    buildVersion({ FLY_IMAGE_REF: `registry.fly.io/church-management-system:${SHA}@sha256:${'a'.repeat(64)}` }),
    { commit: '6f149e0' },
  );
  assert.deepStrictEqual(
    buildVersion({ FLY_IMAGE_REF: 'registry.fly.io/church-management-system:deployment-01K8ZQ3M4N5P6Q7R8S9T0V1W2X' }),
    { deployment: 'deployment-01K8ZQ3M4N5P6Q7R8S9T0V1W2X' },
  );
  assert.deepStrictEqual(buildVersion({}), {});
  assert.deepStrictEqual(buildVersion({ FLY_IMAGE_REF: 'registry.fly.io/church-management-system' }), {});
});

test('/healthz reports the live build without touching the database', async () => {
  const previous = process.env.FLY_IMAGE_REF;
  process.env.FLY_IMAGE_REF = `registry.fly.io/church-management-system:${SHA}`;
  // Nothing listens on port 1, so any query would fail: a 200 proves no DB access.
  const pool = new Pool({ connectionString: 'postgresql://unused:unused@127.0.0.1:1/unused' });
  const app = createTenantApp({ pool, sessionSecret: 'build-version-test-secret' });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/healthz`);
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(await response.json(), { status: 'ok', commit: '6f149e0' });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
    if (previous === undefined) delete process.env.FLY_IMAGE_REF;
    else process.env.FLY_IMAGE_REF = previous;
  }
});
