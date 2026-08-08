#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const contract = require(path.join(projectRoot, 'config', 'runtime-contract.json'));
const version = contract.product.version;
const escapedVersion = version.replaceAll('.', '\\.');

const updateOrigin = 'https://updates.rcart.app';

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

async function main() {
  const [arm64, x64, site, license, updates] = await Promise.all([
    verifyArch('arm64'),
    verifyArch('x64'),
    checked('https://rcart.app/download').then(response => response.text()),
    checked('https://license.rcart.app/health').then(response => response.json()),
    checked(`${updateOrigin}/health`).then(response => response.json()),
  ]);
  assert.match(site, /Download Zyn/);
  assert.doesNotMatch(site, /rCart/);
  assert.equal(license.service, 'zyn-license-api');
  assert.equal(updates.service, 'zyn-updates');
  console.log(JSON.stringify({ ok: true, version, arm64, x64 }, null, 2));
}

main().catch(error => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
