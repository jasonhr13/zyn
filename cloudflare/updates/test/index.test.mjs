import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../src/index.js';

const encoder = new TextEncoder();

function asBytes(value) {
  if (typeof value === 'string') return encoder.encode(value);
  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  throw new TypeError('Unsupported test object body');
}

async function readBytes(value) {
  if (typeof value === 'string' || value instanceof Uint8Array || value instanceof ArrayBuffer
      || ArrayBuffer.isView(value)) {
    return asBytes(value);
  }
  return new Uint8Array(await new Response(value).arrayBuffer());
}

function releaseStore(entries = {}) {
  const records = new Map();
  let revision = 0;

  for (const [key, entry] of Object.entries(entries)) {
    const structured = entry && typeof entry === 'object'
      && !ArrayBuffer.isView(entry) && !(entry instanceof ArrayBuffer)
      && Object.hasOwn(entry, 'body');
    records.set(key, {
      bytes: asBytes(structured ? entry.body : entry),
      httpMetadata: structured ? { ...(entry.httpMetadata || {}) } : {},
      customMetadata: structured ? { ...(entry.customMetadata || {}) } : {},
      etag: `seed-${revision += 1}`,
    });
  }

  function objectFor(key, withBody) {
    const record = records.get(key);
    if (!record) return null;
    const object = {
      key,
      size: record.bytes.byteLength,
      httpEtag: `"${record.etag}"`,
      customMetadata: { ...record.customMetadata },
      writeHttpMetadata(headers) {
        if (record.httpMetadata.contentType) headers.set('content-type', record.httpMetadata.contentType);
        if (record.httpMetadata.cacheControl) headers.set('cache-control', record.httpMetadata.cacheControl);
      },
    };
    if (withBody) {
      object.body = record.bytes.slice();
      object.text = async () => new TextDecoder().decode(record.bytes);
      object.arrayBuffer = async () => record.bytes.slice().buffer;
    }
    return object;
  }

  return {
    records,
    async get(key) {
      return objectFor(key, true);
    },
    async head(key) {
      return objectFor(key, false);
    },
    async put(key, value, options = {}) {
      const bytes = await readBytes(value);
      records.set(key, {
        bytes,
        httpMetadata: { ...(options.httpMetadata || {}) },
        customMetadata: { ...(options.customMetadata || {}) },
        etag: `put-${revision += 1}`,
      });
      return objectFor(key, false);
    },
    async createMultipartUpload(key) {
      return { key, uploadId: 'test-upload' };
    },
    resumeMultipartUpload() {
      throw new Error('Multipart continuation is not used by these tests');
    },
  };
}

async function sha256(value) {
  const bytes = asBytes(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function metadataFor(version, bytes, digest, publishedAt = '2026-08-11T18:00:00.000Z') {
  return {
    schemaVersion: 1,
    name: 'Zyn Harvester',
    version,
    filename: `Zyn-Harvester-${version}.zip`,
    size: bytes.byteLength,
    sha256: digest,
    publishedAt,
  };
}

function authenticatedRequest(url, options = {}) {
  const headers = new Headers(options.headers);
  headers.set('authorization', 'Bearer test-token');
  return new Request(url, { ...options, headers });
}

async function uploadArchive(env, version, bytes, expectedDigest) {
  const digest = expectedDigest || await sha256(bytes);
  return worker.fetch(authenticatedRequest(
    `https://updates.zynbot.app/__upload/extension/Zyn-Harvester-${version}.zip?action=put`,
    {
      method: 'PUT',
      headers: {
        'content-length': String(bytes.byteLength),
        'x-object-sha256': digest,
        'x-object-content-type': 'application/zip',
      },
      body: bytes,
      duplex: 'half',
    },
  ), env);
}

function publishRequest(metadata) {
  return authenticatedRequest('https://updates.zynbot.app/__publish/extension', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(metadata),
  });
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

test('advertises desktop architectures and the extension release channel', async () => {
  const response = await worker.fetch(new Request('https://updates.rcart.app/health'), {
    RELEASES: releaseStore(),
  });
  assert.deepEqual(await response.json(), {
    service: 'zyn-updates',
    status: 'ok',
    macArchitectures: ['arm64', 'x64'],
    windowsArchitectures: ['x64'],
    extensionChannel: true,
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
    assert.match(await response.text(), /^version: 1\.6\.93\nfiles: \[\]/);
  }
});

test('authorizes Zyn runtime multipart uploads with the Zyn secret', async () => {
  const response = await worker.fetch(authenticatedRequest(
    'https://updates.rcart.app/__upload/runtimes/runtime.tar.xz?action=mpu-create',
    { method: 'POST' },
  ), { RELEASES: releaseStore(), ZYN_UPLOAD_TOKEN: 'test-token' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { key: 'runtimes/runtime.tar.xz', uploadId: 'test-upload' });
});

test('routes the stable extension download and rejects malformed feeds', async () => {
  const bytes = encoder.encode('zip');
  const digest = await sha256(bytes);
  const metadata = metadataFor('1.1.2', bytes, digest);
  const env = { RELEASES: releaseStore({
    'extension/latest.json': JSON.stringify(metadata),
  }) };

  for (const method of ['GET', 'HEAD']) {
    const response = await worker.fetch(new Request(
      'https://updates.zynbot.app/download/extension',
      { method },
    ), env);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), 'https://updates.zynbot.app/extension/Zyn-Harvester-1.1.2.zip');
    assert.equal(response.headers.get('cache-control'), 'no-store');

    const versioned = await worker.fetch(new Request(
      'https://updates.zynbot.app/download/extension/1.1.2',
      { method },
    ), env);
    assert.equal(versioned.status, 302);
    assert.equal(versioned.headers.get('location'), 'https://updates.zynbot.app/extension/Zyn-Harvester-1.1.2.zip');
    assert.equal(versioned.headers.get('cache-control'), 'no-store');
  }

  const missing = await worker.fetch(new Request('https://updates.zynbot.app/download/extension'), {
    RELEASES: releaseStore(),
  });
  const malformed = await worker.fetch(new Request('https://updates.zynbot.app/download/extension'), {
    RELEASES: releaseStore({ 'extension/latest.json': '{not json' }),
  });
  assert.equal(missing.status, 404);
  assert.equal(malformed.status, 404);
});

test('extension release paths reject nesting, traversal, and unsupported methods', async () => {
  const env = { RELEASES: releaseStore() };
  for (const pathname of [
    '/extension/nested/Zyn-Harvester-1.1.2.zip',
    '/extension/%2e%2e%2fwindows%2flatest.yml',
    '/extension/%E0%A4%A',
  ]) {
    const response = await worker.fetch(new Request(`https://updates.zynbot.app${pathname}`), env);
    assert.equal(response.status, 404);
  }
  const response = await worker.fetch(new Request('https://updates.zynbot.app/download/extension', {
    method: 'POST',
  }), env);
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET, HEAD');
  const invalidVersion = await worker.fetch(new Request(
    'https://updates.zynbot.app/download/extension/0.0.0',
  ), env);
  assert.equal(invalidVersion.status, 404);
});

test('blocks generic extension metadata writes and all extension multipart actions', async () => {
  const env = { RELEASES: releaseStore(), ZYN_UPLOAD_TOKEN: 'test-token' };
  const metadataWrite = await worker.fetch(authenticatedRequest(
    'https://updates.zynbot.app/__upload/extension/latest.json?action=put',
    { method: 'PUT', body: '{}' },
  ), env);
  const multipart = await worker.fetch(authenticatedRequest(
    'https://updates.zynbot.app/__upload/extension/Zyn-Harvester-1.1.2.zip?action=mpu-create',
    { method: 'POST' },
  ), env);
  assert.equal(metadataWrite.status, 409);
  assert.equal(multipart.status, 400);
  assert.equal(env.RELEASES.records.has('extension/latest.json'), false);
});

test('uploads extension archives immutably with literal SHA-256 verification', async () => {
  const bytes = encoder.encode('PK extension archive one');
  const digest = await sha256(bytes);
  const env = { RELEASES: releaseStore(), ZYN_UPLOAD_TOKEN: 'test-token' };

  const created = await uploadArchive(env, '1.1.2', bytes, digest);
  assert.equal(created.status, 200);
  assert.deepEqual(await created.json(), {
    key: 'extension/Zyn-Harvester-1.1.2.zip',
    etag: '"put-1"',
    duplicate: false,
    version: '1.1.2',
    size: bytes.byteLength,
    sha256: digest,
  });

  const duplicate = await uploadArchive(env, '1.1.2', bytes, digest);
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).duplicate, true);

  const differentBytes = encoder.encode('PK different archive');
  const conflict = await uploadArchive(env, '1.1.2', differentBytes);
  assert.equal(conflict.status, 409);

  const falseDigest = `${digest.slice(0, -1)}${digest.endsWith('0') ? '1' : '0'}`;
  const invalid = await uploadArchive({
    RELEASES: releaseStore(),
    ZYN_UPLOAD_TOKEN: 'test-token',
  }, '1.1.3', bytes, falseDigest);
  assert.equal(invalid.status, 409);
});

test('serves immutable extension ZIPs with stable installation and integrity headers', async () => {
  const bytes = encoder.encode('PK extension archive');
  const digest = await sha256(bytes);
  const env = { RELEASES: releaseStore(), ZYN_UPLOAD_TOKEN: 'test-token' };
  assert.equal((await uploadArchive(env, '1.1.2', bytes, digest)).status, 200);

  const response = await worker.fetch(new Request(
    'https://updates.zynbot.app/extension/Zyn-Harvester-1.1.2.zip',
    { method: 'HEAD' },
  ), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/zip');
  assert.equal(response.headers.get('content-length'), String(bytes.byteLength));
  assert.equal(response.headers.get('content-disposition'), 'attachment; filename="Zyn-Harvester.zip"');
  assert.equal(response.headers.get('x-zyn-sha256'), digest);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
});

test('publishes verified metadata and sends one branded Discord notification', async () => {
  const bytes = encoder.encode('PK release notification archive');
  const digest = await sha256(bytes);
  const metadata = metadataFor('1.1.2', bytes, digest);
  const env = {
    RELEASES: releaseStore(),
    ZYN_UPLOAD_TOKEN: 'test-token',
    ZYN_EXTENSION_RELEASE_DISCORD_WEBHOOK: 'https://discord.com/api/webhooks/123/test-token',
  };
  assert.equal((await uploadArchive(env, metadata.version, bytes, digest)).status, 200);

  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return Response.json({ id: 'discord-message-1' });
  };
  try {
    const published = await worker.fetch(publishRequest(metadata), env);
    assert.equal(published.status, 200);
    assert.deepEqual(await published.json(), {
      published: true,
      notified: true,
      duplicate: false,
      version: '1.1.2',
      downloadUrl: 'https://updates.zynbot.app/download/extension/1.1.2',
      messageId: 'discord-message-1',
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://discord.com/api/v10/webhooks/123/test-token?wait=true');
    assert.equal(calls[0].options.redirect, 'manual');
    assert.equal(
      calls[0].options.headers['user-agent'],
      'DiscordBot (https://zynbot.app, 1.0)',
    );
    const payload = JSON.parse(calls[0].options.body);
    assert.equal(payload.username, 'Zyn');
    assert.equal(payload.avatar_url, 'https://zynbot.app/zyn-icon.png');
    assert.deepEqual(payload.allowed_mentions, { parse: [] });
    assert.equal(payload.embeds[0].title, 'Zyn Harvester v1.1.2 is ready');
    assert.equal(payload.embeds[0].url, 'https://updates.zynbot.app/download/extension/1.1.2');
    assert.match(payload.embeds[0].description, /https:\/\/updates\.zynbot\.app\/download\/extension\/1\.1\.2/);
    assert.equal(payload.embeds[0].thumbnail.url, 'https://zynbot.app/zyn-icon.png');
    assert.equal(payload.embeds[0].footer.icon_url, 'https://zynbot.app/zyn-icon.png');
    assert.equal(payload.embeds[0].color, 14753096);

    const feedRecord = env.RELEASES.records.get('extension/latest.json');
    assert.deepEqual(JSON.parse(new TextDecoder().decode(feedRecord.bytes)), metadata);
    assert.equal(feedRecord.httpMetadata.cacheControl, 'no-store');
    assert.equal(feedRecord.httpMetadata.contentType, 'application/json; charset=utf-8');

    const repeated = await worker.fetch(publishRequest({
      ...metadata,
      publishedAt: '2026-08-11T19:00:00.000Z',
    }), env);
    assert.equal(repeated.status, 200);
    assert.deepEqual(await repeated.json(), {
      published: true,
      notified: true,
      duplicate: true,
      version: '1.1.2',
      downloadUrl: 'https://updates.zynbot.app/download/extension/1.1.2',
      messageId: 'discord-message-1',
    });
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('publish verifies stored ZIP bytes rather than trusting object metadata', async () => {
  const claimedBytes = encoder.encode('claimed bytes');
  const corruptBytes = encoder.encode('corrupt bytes');
  assert.equal(claimedBytes.byteLength, corruptBytes.byteLength);
  const digest = await sha256(claimedBytes);
  const metadata = metadataFor('1.1.2', claimedBytes, digest);
  const env = {
    RELEASES: releaseStore({
      [`extension/${metadata.filename}`]: {
        body: corruptBytes,
        customMetadata: { sha256: digest, version: metadata.version },
        httpMetadata: { contentType: 'application/zip' },
      },
    }),
    ZYN_UPLOAD_TOKEN: 'test-token',
  };
  const response = await worker.fetch(publishRequest(metadata), env);
  assert.equal(response.status, 409);
  assert.equal(env.RELEASES.records.has('extension/latest.json'), false);
});

test('publish rejects unknown metadata fields, downgrades, and same-version conflicts', async () => {
  const currentBytes = encoder.encode('current archive');
  const currentDigest = await sha256(currentBytes);
  const current = metadataFor('1.1.2', currentBytes, currentDigest);
  const olderBytes = encoder.encode('older archive');
  const olderDigest = await sha256(olderBytes);
  const older = metadataFor('1.1.1', olderBytes, olderDigest);
  const env = {
    RELEASES: releaseStore({
      'extension/latest.json': JSON.stringify(current),
      [`extension/${older.filename}`]: {
        body: olderBytes,
        customMetadata: { sha256: olderDigest, version: older.version },
      },
    }),
    ZYN_UPLOAD_TOKEN: 'test-token',
  };

  const extraField = await worker.fetch(publishRequest({ ...older, downloadUrl: 'https://example.test' }), env);
  assert.equal(extraField.status, 400);
  const allZeroVersion = await worker.fetch(publishRequest({
    ...older,
    version: '0.0.0',
    filename: 'Zyn-Harvester-0.0.0.zip',
  }), env);
  assert.equal(allZeroVersion.status, 400);
  const downgrade = await worker.fetch(publishRequest(older), env);
  assert.equal(downgrade.status, 409);

  const changedBytes = encoder.encode('changed archive');
  const changedDigest = await sha256(changedBytes);
  const changed = metadataFor('1.1.2', changedBytes, changedDigest);
  const conflictEnv = {
    RELEASES: releaseStore({
      'extension/latest.json': JSON.stringify(current),
      [`extension/${changed.filename}`]: {
        body: changedBytes,
        customMetadata: { sha256: changedDigest, version: changed.version },
      },
    }),
    ZYN_UPLOAD_TOKEN: 'test-token',
  };
  const conflict = await worker.fetch(publishRequest(changed), conflictEnv);
  assert.equal(conflict.status, 409);
});

test('keeps a verified feed live and safely retries a failed Discord notification', async () => {
  const bytes = encoder.encode('PK retry archive');
  const digest = await sha256(bytes);
  const metadata = metadataFor('1.1.2', bytes, digest);
  const env = { RELEASES: releaseStore(), ZYN_UPLOAD_TOKEN: 'test-token' };
  assert.equal((await uploadArchive(env, metadata.version, bytes, digest)).status, 200);

  const failed = await worker.fetch(publishRequest(metadata), env);
  assert.equal(failed.status, 502);
  assert.deepEqual(await failed.json(), {
    published: true,
    notified: false,
    duplicate: false,
    version: '1.1.2',
    downloadUrl: 'https://updates.zynbot.app/download/extension/1.1.2',
    error: 'Discord webhook configuration is invalid.',
  });
  assert.equal(env.RELEASES.records.has('extension/latest.json'), true);

  env.ZYN_EXTENSION_RELEASE_DISCORD_WEBHOOK = 'https://discord.com/api/webhooks/123/test-token';
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return Response.json({ retry_after: 0 }, { status: 429 });
    return Response.json({ id: 'discord-message-retry' });
  };
  try {
    const retried = await worker.fetch(publishRequest(metadata), env);
    assert.equal(retried.status, 200);
    assert.deepEqual(await retried.json(), {
      published: true,
      notified: true,
      duplicate: true,
      version: '1.1.2',
      downloadUrl: 'https://updates.zynbot.app/download/extension/1.1.2',
      messageId: 'discord-message-retry',
    });
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('publish authentication is non-enumerable and invalid webhook errors stay sanitized', async () => {
  const unauthorized = await worker.fetch(new Request('https://updates.zynbot.app/__publish/extension', {
    method: 'POST',
    body: '{}',
  }), { RELEASES: releaseStore(), ZYN_UPLOAD_TOKEN: 'test-token' });
  assert.equal(unauthorized.status, 404);

  const bytes = encoder.encode('PK invalid webhook archive');
  const digest = await sha256(bytes);
  const metadata = metadataFor('1.1.2', bytes, digest);
  const env = {
    RELEASES: releaseStore(),
    ZYN_UPLOAD_TOKEN: 'test-token',
    ZYN_EXTENSION_RELEASE_DISCORD_WEBHOOK: 'https://example.test/api/webhooks/123/secret-value',
  };
  assert.equal((await uploadArchive(env, metadata.version, bytes, digest)).status, 200);
  const response = await worker.fetch(publishRequest(metadata), env);
  assert.equal(response.status, 502);
  const body = await response.text();
  assert.equal(body.includes('secret-value'), false);
  assert.deepEqual(JSON.parse(body), {
    published: true,
    notified: false,
    duplicate: false,
    version: '1.1.2',
    downloadUrl: 'https://updates.zynbot.app/download/extension/1.1.2',
    error: 'Discord webhook configuration is invalid.',
  });
});
