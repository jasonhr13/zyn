#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { RuntimeManager, verifyManifest } = require('../launcher/runtime-manager');

async function hash(file) {
  const digest = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

async function archiveFixture(root, name, layout, format = 'tar.xz') {
  const source = path.join(root, `${name}-source`);
  for (const [relative, contents] of Object.entries(layout)) {
    const file = path.join(source, relative);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, contents, { mode: 0o755 });
  }
  const archive = path.join(root, `${name}.${format}`);
  execFileSync('/usr/bin/tar', [format === 'tar.gz' ? '-czf' : '-cJf', archive, '-C', source, '.']);
  return { archive, size: (await fsp.stat(archive)).size, sha256: await hash(archive), format };
}

function runtimeItem(label, version, fixture, entry, extra = {}) {
  return {
    label,
    version,
    archive: path.basename(fixture.archive),
    url: `/runtimes/${path.basename(fixture.archive)}`,
    size: fixture.size,
    sha256: fixture.sha256,
    entry,
    verify: entry,
    format: fixture.format,
    ...extra,
  };
}

async function main() {
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'zyn-runtime-smoke-'));
  let server;
  try {
    const chromium = await archiveFixture(temporary, 'chromium-test', {
      'ms-playwright/chromium-1228/chrome': 'signed chromium fixture',
    });
    const wine = await archiveFixture(temporary, 'wine-test', {
      'Wine Stable.app/Contents/Resources/wine/bin/wine': 'signed wine fixture',
    });
    const engine = await archiveFixture(temporary, 'engine-test', {
      'engine/backend.exe': Buffer.from('MZ signed engine fixture'),
    }, 'tar.gz');
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    let manifest;
    let rangeRequests = 0;

    server = http.createServer(async (request, response) => {
      if (request.url === '/runtimes/manifest.json') {
        const body = Buffer.from(JSON.stringify(manifest));
        response.writeHead(200, { 'content-type': 'application/json', 'content-length': body.length });
        response.end(body);
        return;
      }
      const filename = path.basename(request.url || '');
      const source = [chromium.archive, wine.archive, engine.archive]
        .find((candidate) => path.basename(candidate) === filename);
      if (!source) {
        response.writeHead(404);
        response.end();
        return;
      }
      const data = await fsp.readFile(source);
      const match = String(request.headers.range || '').match(/^bytes=(\d+)-$/);
      if (match) {
        rangeRequests += 1;
        const offset = Number(match[1]);
        response.writeHead(206, {
          'content-range': `bytes ${offset}-${data.length - 1}/${data.length}`,
          'content-length': data.length - offset,
        });
        response.end(data.subarray(offset));
        return;
      }
      response.writeHead(200, { 'content-length': data.length });
      response.end(data);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const browserItem = runtimeItem(
      'Chromium',
      'test-1',
      chromium,
      'ms-playwright/chromium-1228/chrome',
      { root: 'ms-playwright' },
    );
    const wineItem = runtimeItem(
      'Wine',
      '11.0_1',
      wine,
      'Wine Stable.app/Contents/Resources/wine/bin/wine',
      { requiresRosetta: true },
    );
    const engineItem = runtimeItem('Checkout engine', 'test-1', engine, 'engine/backend.exe', {
      sourceSha256: '6c381523e02af2c7e2e49be01243d65d4e95ae22c2d45a32eb23ef1b00d57ce2',
    });
    const payload = {
      generatedAt: new Date().toISOString(),
      platforms: {
        'darwin-arm64': { chromium: browserItem, wine: wineItem },
        'darwin-x64': { chromium: browserItem, wine: { ...wineItem, requiresRosetta: false } },
      },
      engine: engineItem,
    };
    manifest = {
      schema: 1,
      payload,
      signature: crypto.sign(null, Buffer.from(JSON.stringify(payload)), privateKey).toString('base64'),
    };
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
    assert.deepEqual(verifyManifest(manifest, publicPem), payload);
    assert.throws(() => verifyManifest({ ...manifest, payload: { ...payload, generatedAt: 'tampered' } }, publicPem));

    const root = path.join(temporary, 'installed');
    const partialDirectory = path.join(root, '.downloads');
    await fsp.mkdir(partialDirectory, { recursive: true });
    const chromiumBytes = await fsp.readFile(chromium.archive);
    await fsp.writeFile(
      path.join(partialDirectory, `${path.basename(chromium.archive)}.partial`),
      chromiumBytes.subarray(0, 12),
    );

    const statuses = [];
    const manager = new RuntimeManager({
      enabled: true,
      platform: 'darwin',
      arch: 'x64',
      root,
      origin,
      manifestUrl: `${origin}/runtimes/manifest.json`,
      publicKey: publicPem,
      log: { warn() {}, error() {} },
      onStatus: (status) => statuses.push(status),
      verifyArtifact: async ({ entry }) => assert.equal(fs.existsSync(entry), true),
    });
    await manager.initialize();
    const status = await manager.ensureAll();
    assert.equal(status.ready, true);
    assert.equal(status.percent, 100);
    assert.equal(status.items.chromium.state, 'ready');
    assert.equal(status.items.wine.state, 'ready');
    assert.equal(status.items.engine.state, 'ready');
    assert.ok(rangeRequests >= 1, 'partial download was not resumed with a byte range');
    assert.ok(process.env.ZYN_PLAYWRIGHT_BROWSERS_PATH.endsWith('/chromium/test-1/ms-playwright'));
    assert.ok(process.env.ZYN_WINE_PATH.endsWith('/wine/11.0_1/Wine Stable.app/Contents/Resources/wine/bin/wine'));
    assert.ok(process.env.ZYN_ENGINE_PATH.endsWith('/engine/test-1/engine/backend.exe'));
    assert.ok(statuses.some((item) => item.state === 'downloading'));
    assert.ok(statuses.some((item) => item.state === 'installing'));

    const armManager = new RuntimeManager({
      enabled: true,
      platform: 'darwin',
      arch: 'arm64',
      root,
      origin,
      manifestUrl: `${origin}/runtimes/manifest.json`,
      publicKey: publicPem,
      log: { warn() {}, error() {} },
      verifyArtifact: async () => {},
      checkRosetta: async () => false,
    });
    await armManager.initialize();
    const blocked = await armManager.reconcile();
    assert.equal(blocked.ready, false);
    assert.equal(blocked.state, 'error');
    assert.equal(blocked.items.wine.state, 'blocked');
    assert.match(blocked.error, /Rosetta 2 is required/);

    console.log('Zyn runtime manager download, resume, verification, install, and dual-architecture smoke test passed');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await fsp.rm(temporary, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
