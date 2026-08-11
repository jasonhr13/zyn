#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  METADATA_FILENAME,
  artifactFilename,
  assertCleanExtensionSource,
  bumpManifestSource,
  createDeterministicZip,
  nextPatchVersion,
  releaseMetadata,
  sha256File,
  trackedExtensionFiles,
  validChromeVersion,
  validateReleaseMetadata,
  verifyExtensionRelease,
} = require('./zyn-extension-release-lib.cjs');
const {
  releaseUrls,
  uploadAndPublish,
  validateLiveMetadata,
  validatePublishResult,
} = require('./upload-zyn-extension-release.cjs');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'zyn-extension-release-smoke-'));
const sourceRoot = path.join(temporary, 'source');
const outputOne = path.join(temporary, 'output-one');
const outputTwo = path.join(temporary, 'output-two');
const files = ['README.md', 'assets/icon.png', 'index.js', 'manifest.json'];
const version = '1.1.2';

function fixtureManifest(fixtureVersion = version) {
  return `${JSON.stringify({
    name: 'Zyn Harvester',
    description: 'Fixture',
    version: fixtureVersion,
    manifest_version: 3,
    background: { service_worker: 'index.js' },
  }, null, 2)}\n`;
}

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function redirectResponse(location) {
  return new Response(null, { status: 302, headers: { location } });
}

function artifactHeaders(metadata) {
  return {
    'content-type': 'application/zip',
    'content-length': String(metadata.size),
    'content-disposition': 'attachment; filename="Zyn-Harvester.zip"',
    'x-zyn-sha256': metadata.sha256,
    'cache-control': 'public, max-age=31536000, immutable',
  };
}

async function run() {
  try {
    assert.equal(nextPatchVersion('1.1.1'), '1.1.2');
    assert.equal(nextPatchVersion('65535.0.0'), '65535.0.1');
    assert.throws(() => nextPatchVersion('1.2'), /three-part/);
    assert.throws(() => nextPatchVersion('1.2.65535'), /new minor version/);
    for (const value of ['1', '1.2', '1.2.3', '1.2.3.4', '0.0.1', '65535.65535.65535.65535']) {
      assert.equal(validChromeVersion(value), true, value);
    }
    for (const value of ['', '0', '0.0.0', '01.2.3', '1.2.3.4.5', '1.2.65536', '1.2.beta']) {
      assert.equal(validChromeVersion(value), false, value);
    }
    const formattedManifest = '{\n  "name": "Zyn Harvester",\n  "version": "1.1.1",\n  "manifest_version": 3\n}\n';
    const bumped = bumpManifestSource(formattedManifest);
    assert.equal(bumped.previous, '1.1.1');
    assert.equal(bumped.next, version);
    assert.equal(bumped.source, formattedManifest.replace('1.1.1', version));

    fs.mkdirSync(path.join(sourceRoot, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, 'manifest.json'), fixtureManifest());
    fs.writeFileSync(path.join(sourceRoot, 'index.js'), "console.log('fixture');\n");
    fs.writeFileSync(path.join(sourceRoot, 'README.md'), '# Fixture\n');
    fs.writeFileSync(path.join(sourceRoot, 'assets', 'icon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const gitProject = path.join(temporary, 'git-project');
    const gitExtension = path.join(gitProject, 'chrome-extension', 'harvester');
    fs.mkdirSync(gitExtension, { recursive: true });
    for (const relative of files) {
      const from = path.join(sourceRoot, ...relative.split('/'));
      const to = path.join(gitExtension, ...relative.split('/'));
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
    execFileSync('git', ['init', '-q'], { cwd: gitProject });
    execFileSync('git', ['add', '--', 'chrome-extension/harvester'], { cwd: gitProject });
    execFileSync('git', [
      '-c', 'user.name=Zyn Release Fixture', '-c', 'user.email=fixture@zynbot.app',
      'commit', '-q', '-m', 'fixture',
    ], { cwd: gitProject });
    assert.deepEqual(trackedExtensionFiles(gitProject), [...files].sort());
    assert.doesNotThrow(() => assertCleanExtensionSource(gitProject));
    fs.writeFileSync(path.join(gitExtension, 'untracked-secret.txt'), 'must not ship');
    assert.deepEqual(trackedExtensionFiles(gitProject), [...files].sort(), 'untracked file entered payload');
    assert.throws(() => assertCleanExtensionSource(gitProject), /not clean/);

    fs.mkdirSync(outputOne, { recursive: true });
    fs.mkdirSync(outputTwo, { recursive: true });

    const filename = artifactFilename(version);
    const zipOne = createDeterministicZip({
      sourceRoot,
      files,
      destination: path.join(outputOne, filename),
    });
    const zipTwo = createDeterministicZip({
      sourceRoot,
      files: [...files].reverse(),
      destination: path.join(outputTwo, filename),
    });
    assert.equal(sha256File(zipOne), sha256File(zipTwo), 'extension ZIP is not reproducible');
    assert.ok(fs.readFileSync(zipOne).equals(fs.readFileSync(zipTwo)), 'extension ZIP bytes differ');

    const metadata = releaseMetadata({
      version,
      file: zipOne,
      publishedAt: '2026-08-11T20:00:00.000Z',
    });
    assert.deepEqual(Object.keys(metadata), [
      'schemaVersion', 'name', 'version', 'filename', 'size', 'sha256', 'publishedAt',
    ]);
    fs.writeFileSync(path.join(outputOne, METADATA_FILENAME), `${JSON.stringify(metadata, null, 2)}\n`);
    const verified = verifyExtensionRelease({ sourceRoot, files, outputRoot: outputOne });
    assert.equal(verified.metadata.version, version);
    assert.equal(verified.entries, files.length);
    assert.equal(
      execFileSync('/usr/bin/unzip', ['-p', zipOne, 'manifest.json'], { encoding: 'utf8' }),
      fixtureManifest(),
      'manifest.json is not at the ZIP root',
    );

    assert.throws(
      () => validateReleaseMetadata({ ...metadata, unexpected: true }),
      /must contain exactly/,
    );
    assert.throws(
      () => validateReleaseMetadata({ ...metadata, filename: 'Zyn-Harvester.zip' }),
      /filename does not match/,
    );
    const symlink = path.join(sourceRoot, 'linked.js');
    fs.symlinkSync('index.js', symlink);
    assert.throws(
      () => createDeterministicZip({
        sourceRoot,
        files: [...files, 'linked.js'],
        destination: path.join(temporary, 'symlink.zip'),
      }),
      /regular files only/,
    );
    fs.rmSync(symlink);

    const tamperedRoot = path.join(temporary, 'tampered');
    fs.mkdirSync(tamperedRoot);
    const tamperedZip = path.join(tamperedRoot, filename);
    fs.copyFileSync(zipOne, tamperedZip);
    fs.writeFileSync(path.join(tamperedRoot, 'unexpected.txt'), 'unexpected');
    execFileSync('/usr/bin/zip', ['-X', '-q', tamperedZip, 'unexpected.txt'], { cwd: tamperedRoot });
    const tamperedMetadata = {
      ...metadata,
      size: fs.statSync(tamperedZip).size,
      sha256: sha256File(tamperedZip),
    };
    fs.writeFileSync(path.join(tamperedRoot, METADATA_FILENAME), JSON.stringify(tamperedMetadata));
    assert.throws(
      () => verifyExtensionRelease({ sourceRoot, files, outputRoot: tamperedRoot }),
      /do not exactly match/,
    );

    const live = { ...metadata };
    const urls = releaseUrls(metadata);
    assert.equal(urls.downloadUrl, 'https://zynbot.app/download/extension');
    assert.equal(urls.versionedDownloadUrl, `https://zynbot.app/download/extension/${version}`);
    assert.equal(urls.artifactUrl, `https://updates.zynbot.app/extension/${filename}`);
    assert.deepEqual(validateLiveMetadata({ ...live }), live);
    assert.throws(() => validateLiveMetadata({ ...live, extra: true }), /must contain exactly/);

    const zipBody = fs.readFileSync(zipOne);
    const calls = [];
    const fetchImpl = async (input, options = {}) => {
      const url = String(input);
      const method = options.method || 'GET';
      calls.push({ url, method, options });
      if (url.startsWith('https://upload.example/__upload/extension/')) {
        assert.equal(method, 'PUT');
        assert.equal(options.redirect, 'error');
        assert.equal(options.headers['x-object-sha256'], metadata.sha256);
        assert.equal(options.headers['content-length'], String(metadata.size));
        assert.ok(Buffer.from(options.body).equals(zipBody));
        return jsonResponse({ key: `extension/${filename}`, etag: 'fixture' });
      }
      if (url === 'https://upload.example/__publish/extension') {
        assert.equal(method, 'POST');
        assert.deepEqual(JSON.parse(options.body), metadata);
        return jsonResponse({
          published: true,
          notified: true,
          duplicate: false,
          version,
          downloadUrl: urls.versionedDownloadUrl,
          messageId: '123456789012345678',
        });
      }
      if (url.startsWith('https://updates.zynbot.app/extension/latest.json?')) return jsonResponse(live);
      if (url === 'https://zynbot.app/download/extension' && method === 'HEAD') {
        return redirectResponse('https://updates.zynbot.app/download/extension');
      }
      if (url === 'https://updates.zynbot.app/download/extension' && method === 'HEAD') {
        return redirectResponse(urls.artifactUrl);
      }
      if (url === urls.versionedDownloadUrl && method === 'HEAD') return redirectResponse(urls.artifactUrl);
      if (url === urls.artifactUrl && method === 'HEAD') {
        return new Response(null, { status: 200, headers: artifactHeaders(metadata) });
      }
      if (url === urls.artifactUrl && method === 'GET') {
        return new Response(zipBody, { status: 200, headers: artifactHeaders(metadata) });
      }
      throw new Error(`Unexpected mocked fetch: ${method} ${url}`);
    };

    const published = await uploadAndPublish({
      fetchImpl,
      token: 'fixture-token',
      zip: zipOne,
      metadata,
      uploadOrigin: 'https://upload.example',
    });
    assert.equal(published.notified, true);
    assert.equal(calls.filter(call => call.method === 'PUT').length, 1);
    assert.equal(calls.filter(call => call.method === 'POST').length, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(sourceRoot, 'manifest.json'))).version, version,
      'upload changed the manifest version');

    assert.throws(
      () => validatePublishResult({
        published: true,
        notified: true,
        duplicate: false,
        version,
        downloadUrl: urls.versionedDownloadUrl,
        messageId: '123',
        extra: true,
      }, metadata, true),
      /unexpected fields/,
    );

    let failurePublished = false;
    const failureFetch = async (input, options = {}) => {
      const url = String(input);
      if (url.startsWith('https://upload.example/__upload/extension/')) return jsonResponse({ ok: true });
      if (url === 'https://upload.example/__publish/extension') {
        failurePublished = true;
        return jsonResponse({
          published: true,
          notified: false,
          duplicate: false,
          version,
          downloadUrl: urls.versionedDownloadUrl,
          error: 'Discord notification failed.',
        }, 502);
      }
      return fetchImpl(input, options);
    };
    await assert.rejects(
      uploadAndPublish({
        fetchImpl: failureFetch,
        token: 'fixture-token',
        zip: zipOne,
        metadata,
        uploadOrigin: 'https://upload.example',
      }),
      /is live, but its Discord notification failed/,
    );
    assert.equal(failurePublished, true);

    const digest = crypto.createHash('sha256').update(zipBody).digest('hex');
    assert.equal(digest, metadata.sha256);
    console.log(JSON.stringify({
      ok: true,
      version,
      files: files.length,
      bytes: metadata.size,
      sha256: metadata.sha256,
      mockedRequests: calls.length,
    }, null, 2));
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
