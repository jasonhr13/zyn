#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const contract = require(path.join(projectRoot, 'config', 'runtime-contract.json'));
const version = contract.product.version;
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

async function main() {
  const [arm64, x64, windows, site, license, updates] = await Promise.all([
    verifyArch('arm64'),
    verifyArch('x64'),
    verifyWindows(),
    checked('https://zynbot.app/download').then(response => response.text()),
    checked('https://license.zynbot.app/health').then(response => response.json()),
    checked(`${updateOrigin}/health`).then(response => response.json()),
  ]);
  assert.match(site, /Download Zyn/);
  assert.doesNotMatch(site, /rCart/);
  assert.equal(license.service, 'zyn-license-api');
  assert.equal(updates.service, 'zyn-updates');
  assert.deepEqual(updates.windowsArchitectures, ['x64']);
  console.log(JSON.stringify({ ok: true, version, arm64, x64, windows }, null, 2));
}

main().catch(error => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
