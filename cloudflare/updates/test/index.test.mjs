import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../src/index.js';

function releaseStore(entries = {}) {
  return {
    async get(key) {
      const body = entries[key];
      if (body == null) return null;
      return {
        body: new TextEncoder().encode(body),
        size: String(body).length,
        httpEtag: `"${key}"`,
        writeHttpMetadata() {},
        async text() { return body; },
      };
    },
    async head() { return null; },
    async createMultipartUpload(key) {
      return { key, uploadId: 'test-upload' };
    },
  };
}

test('routes each Mac download to its own architecture feed', async () => {
  const env = { RELEASES: releaseStore({
    'mac/arm64/latest-mac.yml': 'files:\n  - url: Zyn-1.6.82-arm64.dmg\n',
    'mac/x64/latest-mac.yml': 'files:\n  - url: Zyn-1.6.82-x64.dmg\n',
  }) };

  const arm = await worker.fetch(new Request('https://updates.rcart.app/download/mac/arm64'), env);
  const intel = await worker.fetch(new Request('https://updates.rcart.app/download/mac/x64'), env);
  assert.equal(arm.status, 302);
  assert.equal(intel.status, 302);
  assert.equal(arm.headers.get('location'), 'https://updates.rcart.app/mac/arm64/Zyn-1.6.82-arm64.dmg');
  assert.equal(intel.headers.get('location'), 'https://updates.rcart.app/mac/x64/Zyn-1.6.82-x64.dmg');
});

test('keeps redirects on whichever Zyn domain served the request', async () => {
  const env = { RELEASES: releaseStore({
    'mac/arm64/latest-mac.yml': 'files:\n  - url: Zyn-1.6.82-arm64.dmg\n',
  }) };
  const response = await worker.fetch(new Request('https://updates.zynbot.app/download/mac/arm64'), env);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), 'https://updates.zynbot.app/mac/arm64/Zyn-1.6.82-arm64.dmg');
});

test('keeps the legacy Mac download on Apple silicon', async () => {
  const env = { RELEASES: releaseStore({
    'mac/latest-mac.yml': 'files:\n  - url: Zyn-1.6.74-arm64.dmg\n',
  }) };
  const response = await worker.fetch(new Request('https://updates.rcart.app/download'), env);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), 'https://updates.rcart.app/mac/arm64/Zyn-1.6.74-arm64.dmg');
});

test('routes the Windows download through the latest Windows feed', async () => {
  const env = { RELEASES: releaseStore({
    'windows/latest.yml': 'version: 1.6.82\npath: Zyn-Setup-1.6.82-x64.exe\n',
  }) };
  const response = await worker.fetch(new Request('https://updates.rcart.app/download/windows'), env);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), 'https://updates.rcart.app/windows/Zyn-Setup-1.6.82-x64.exe');
});

test('advertises the supported desktop architectures', async () => {
  const response = await worker.fetch(new Request('https://updates.rcart.app/health'), {
    RELEASES: releaseStore(),
  });
  assert.deepEqual(await response.json(), {
    service: 'zyn-updates',
    status: 'ok',
    macArchitectures: ['arm64', 'x64'],
    windowsArchitectures: ['x64'],
  });
});

test('serves architecture metadata and rejects unknown architectures', async () => {
  const env = { RELEASES: releaseStore({
    'mac/x64/latest-mac.yml': 'version: 1.6.82\n',
  }) };
  const valid = await worker.fetch(new Request('https://updates.rcart.app/mac/x64/latest-mac.yml'), env);
  const invalid = await worker.fetch(new Request('https://updates.rcart.app/mac/universal/latest-mac.yml'), env);
  assert.equal(valid.status, 200);
  assert.equal(invalid.status, 404);
});

test('returns a no-artifact current-version feed before a signed release is published', async () => {
  const env = { RELEASES: releaseStore() };
  for (const arch of ['arm64', 'x64']) {
    const response = await worker.fetch(new Request(`https://updates.rcart.app/mac/${arch}/latest-mac.yml`), env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(await response.text(), /^version: 1\.6\.89\nfiles: \[\]/);
  }
});

test('authorizes Zyn runtime multipart uploads with the Zyn secret', async () => {
  const response = await worker.fetch(new Request(
    'https://updates.rcart.app/__upload/runtimes/runtime.tar.xz?action=mpu-create',
    { method: 'POST', headers: { authorization: 'Bearer test-token' } },
  ), { RELEASES: releaseStore(), ZYN_UPLOAD_TOKEN: 'test-token' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { key: 'runtimes/runtime.tar.xz', uploadId: 'test-upload' });
});
