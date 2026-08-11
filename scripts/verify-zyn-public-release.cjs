#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const contract = require(path.join(projectRoot, 'config', 'runtime-contract.json'));
const extensionManifest = require(path.join(projectRoot, 'chrome-extension', 'harvester', 'manifest.json'));
const version = contract.product.version;
const extensionVersion = extensionManifest.version;
const escapedVersion = version.replaceAll('.', '\\.');

const updateOrigin = 'https://updates.zynbot.app';

async function checked(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${url} failed: ${response.status}`);
  return response;
}

async function verifyArch(arch) {
  const feedUrl = `${updateOrigin}/mac/${arch}/latest-mac.yml`;
  const feed = await (await checked(feedUrl, { headers: { 'cache-control': 'no-cache' } })).text();
  assert.match(feed, new RegExp(`^version:\\s*${escapedVersion}$`, 'm'));
  const dmg = feed.match(/^\s*-\s+url:\s+(Zyn-[A-Za-z0-9.+-]+\.dmg)\s*\n\s+sha512:\s+\S+\s*\n\s+size:\s+(\d+)$/m);
  assert.ok(dmg, `${arch}: DMG entry missing from feed`);
  const download = await fetch(`${updateOrigin}/download/mac/${arch}`, { method: 'HEAD', redirect: 'manual' });
  assert.equal(download.status, 302, `${arch}: download route did not redirect`);
  const expectedUrl = `${updateOrigin}/mac/${arch}/${dmg[1]}`;
  assert.equal(download.headers.get('location'), expectedUrl);
  const artifact = await checked(expectedUrl, { method: 'HEAD' });
  assert.equal(Number(artifact.headers.get('content-length')), Number(dmg[2]));
  return { arch, dmg: dmg[1], bytes: Number(dmg[2]), download: `${updateOrigin}/download/mac/${arch}` };
}

async function verifyWindows() {
  const feedUrl = `${updateOrigin}/windows/latest.yml`;
  const feed = await (await checked(feedUrl, { headers: { 'cache-control': 'no-cache' } })).text();
  assert.match(feed, new RegExp(`^version:\\s*${escapedVersion}$`, 'm'));
  const installer = feed.match(/^path:\s+(Zyn-Setup-[A-Za-z0-9.+-]+-x64\.exe)$/m);
  assert.ok(installer, 'Windows installer path is missing from the feed');
  const size = feed.match(new RegExp(`^\\s*-\\s+url:\\s+${installer[1].replaceAll('.', '\\.')}\\s*\\n\\s+sha512:\\s+\\S+\\s*\\n\\s+size:\\s+(\\d+)$`, 'm'));
  assert.ok(size, 'Windows installer entry is missing from the feed');
  const download = await fetch(`${updateOrigin}/download/windows`, { method: 'HEAD', redirect: 'manual' });
  assert.equal(download.status, 302, 'Windows download route did not redirect');
  const expectedUrl = `${updateOrigin}/windows/${installer[1]}`;
  assert.equal(download.headers.get('location'), expectedUrl);
  const artifact = await checked(expectedUrl, { method: 'HEAD' });
  assert.equal(Number(artifact.headers.get('content-length')), Number(size[1]));
  return { arch: 'x64', installer: installer[1], bytes: Number(size[1]), download: `${updateOrigin}/download/windows` };
}

async function verifyExtension() {
  const metadataUrl = `${updateOrigin}/extension/latest.json`;
  const metadataResponse = await checked(metadataUrl, { headers: { 'cache-control': 'no-cache' } });
  assert.match(metadataResponse.headers.get('content-type') || '', /^application\/json\b/i);
  assert.match(metadataResponse.headers.get('cache-control') || '', /no-store/i);
  const metadata = await metadataResponse.json();

  assert.equal(metadata.schemaVersion, 1);
  assert.equal(metadata.name, 'Zyn Harvester');
  assert.equal(metadata.version, extensionVersion);
  assert.equal(metadata.filename, `Zyn-Harvester-${extensionVersion}.zip`);
  assert.ok(Number.isSafeInteger(metadata.size) && metadata.size > 0, 'extension size is invalid');
  assert.match(metadata.sha256, /^[a-f0-9]{64}$/);
  assert.ok(Number.isFinite(Date.parse(metadata.publishedAt)), 'extension publication date is invalid');

  const artifactUrl = `${updateOrigin}/extension/${metadata.filename}`;
  const stableDownloadUrl = `${updateOrigin}/download/extension`;
  const versionedDownloadUrl = `${stableDownloadUrl}/${extensionVersion}`;
  if (metadata.artifactUrl !== undefined) assert.equal(metadata.artifactUrl, artifactUrl);
  if (metadata.downloadUrl !== undefined) assert.equal(metadata.downloadUrl, versionedDownloadUrl);

  const artifactHead = await checked(artifactUrl, { method: 'HEAD' });
  assert.equal(Number(artifactHead.headers.get('content-length')), metadata.size);
  assert.match(artifactHead.headers.get('content-type') || '', /^application\/zip\b/i);
  assert.equal(artifactHead.headers.get('content-disposition'), 'attachment; filename="Zyn-Harvester.zip"');
  assert.equal(artifactHead.headers.get('x-zyn-sha256'), metadata.sha256);
  assert.match(artifactHead.headers.get('cache-control') || '', /\bimmutable\b/i);

  const artifact = await (await checked(artifactUrl, { headers: { 'cache-control': 'no-cache' } })).arrayBuffer();
  const body = Buffer.from(artifact);
  assert.equal(body.length, metadata.size);
  assert.equal(crypto.createHash('sha256').update(body).digest('hex'), metadata.sha256);

  const updatesDownload = await fetch(`${updateOrigin}/download/extension`, {
    method: 'HEAD',
    redirect: 'manual',
  });
  assert.equal(updatesDownload.status, 302, 'extension update download route did not redirect');
  assert.equal(updatesDownload.headers.get('location'), artifactUrl);

  const versionedDownload = await fetch(versionedDownloadUrl, { method: 'HEAD', redirect: 'manual' });
  assert.equal(versionedDownload.status, 302, 'extension versioned download route did not redirect');
  assert.equal(versionedDownload.headers.get('location'), artifactUrl);

  return {
    version: extensionVersion,
    filename: metadata.filename,
    bytes: metadata.size,
    sha256: metadata.sha256,
    download: stableDownloadUrl,
  };
}

async function main() {
  const [arm64, x64, windows, extension, site, license, updates] = await Promise.all([
    verifyArch('arm64'),
    verifyArch('x64'),
    verifyWindows(),
    verifyExtension(),
    checked('https://zynbot.app/download').then(response => response.text()),
    checked('https://license.zynbot.app/health').then(response => response.json()),
    checked(`${updateOrigin}/health`).then(response => response.json()),
  ]);
  assert.match(site, /Download Zyn/);
  assert.doesNotMatch(site, /rCart/);
  assert.equal(license.service, 'zyn-license-api');
  assert.equal(updates.service, 'zyn-updates');
  assert.deepEqual(updates.windowsArchitectures, ['x64']);
  assert.equal(updates.extensionChannel, true);
  console.log(JSON.stringify({ ok: true, version, extensionVersion, arm64, x64, windows, extension }, null, 2));
}

main().catch(error => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
