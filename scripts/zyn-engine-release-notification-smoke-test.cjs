#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { publishEngineReleaseNotification } = require('./zyn-engine-release-notification-lib.cjs');

function jsonResponse(value, status) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function run() {
  const secret = 'fixture-secret-that-must-not-leak';
  const ok = await publishEngineReleaseNotification({
    fetchImpl: async () => jsonResponse({
      published: true,
      notified: true,
      duplicate: false,
      version: '1.2.5',
      messageId: '123456789012345678',
    }, 200),
    token: secret,
    uploadOrigin: 'https://upload.example',
  });
  assert.equal(ok.version, '1.2.5');
  assert.equal(ok.messageId, '123456789012345678');
  assert.equal(ok.duplicate, false);

  await assert.rejects(
    publishEngineReleaseNotification({
      fetchImpl: async () => jsonResponse({ error: 'malicious server detail' }, 502),
      token: secret,
      uploadOrigin: 'https://upload.example',
    }),
    (error) => {
      assert.match(error.message, /Discord notification failed/);
      assert.doesNotMatch(error.message, new RegExp(secret));
      assert.doesNotMatch(error.message, /malicious server detail/);
      return true;
    },
  );

  console.log('engine release notification smoke test passed');
}

run().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
