#!/usr/bin/env node
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { verifyManifest, MANIFEST_PATH } = require('../launcher/runtime-manager');

const projectRoot = path.join(__dirname, '..');
const artifactsRoot = path.join(projectRoot, 'release', 'runtime-artifacts');
const updateOrigin = (process.env.ZYN_UPDATE_ORIGIN || 'https://updates.rcart.app').replace(/\/+$/, '');
const uploadOrigin = (process.env.ZYN_UPLOAD_ORIGIN || updateOrigin).replace(/\/+$/, '');
const prefix = 'runtimes';
const keychainAccount = process.env.ZYN_UPDATE_KEYCHAIN_ACCOUNT || 'zyn-updates';
const keychainService = process.env.ZYN_UPDATE_KEYCHAIN_SERVICE || 'com.thwebco.zyn.r2-upload';
const manifestName = path.basename(MANIFEST_PATH);
const multipartThreshold = 64 * 1024 * 1024;
const partSize = 32 * 1024 * 1024;
const uploadConcurrency = 3;

const manifestFile = path.join(artifactsRoot, manifestName);
if (!fs.existsSync(manifestFile)) throw new Error(`Missing signed manifest: ${manifestFile}`);
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
const payload = verifyManifest(manifest);
const runtimeItems = [...new Map([
  ...Object.values(payload.platforms || {}).flatMap(platform => Object.values(platform)),
  payload.engine,
].filter(Boolean).map(item => [item.archive, item])).values()];
const assets = [
  ...runtimeItems.map(item => ({
    name: item.archive,
    file: path.join(artifactsRoot, item.archive),
    type: item.format === 'tar.gz' ? 'application/gzip' : 'application/x-xz',
    metadata: false,
  })),
  { name: manifestName, file: manifestFile, type: 'application/json; charset=utf-8', metadata: true },
];

function uploadUrl(asset, action, extra = {}) {
  const url = new URL(`/__upload/${prefix}/${asset.name}`, uploadOrigin);
  url.searchParams.set('action', action);
  for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, String(value));
  return url;
}

function headers(asset, token) {
  return {
    authorization: `Bearer ${token}`,
    'x-object-content-type': asset.type,
    'x-object-cache-control': asset.metadata ? 'no-store' : 'public, max-age=31536000, immutable',
  };
}

async function checkedFetch(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`${options.method || 'GET'} ${url.pathname} failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
  }
  return response;
}

async function uploadSmall(asset, token) {
  await checkedFetch(uploadUrl(asset, 'put'), {
    method: 'PUT',
    headers: headers(asset, token),
    body: await fs.promises.readFile(asset.file),
  });
}

async function uploadMultipart(asset, token, size) {
  const created = await checkedFetch(uploadUrl(asset, 'mpu-create'), {
    method: 'POST',
    headers: headers(asset, token),
  });
  const { uploadId } = await created.json();
  if (!uploadId) throw new Error(`Cloudflare did not return an uploadId for ${asset.name}`);
  const partCount = Math.ceil(size / partSize);
  const completedParts = new Array(partCount);
  const file = await fs.promises.open(asset.file, 'r');
  let nextPart = 0;
  try {
    async function worker() {
      while (true) {
        const index = nextPart++;
        if (index >= partCount) return;
        const offset = index * partSize;
        const length = Math.min(partSize, size - offset);
        const buffer = Buffer.allocUnsafe(length);
        let filled = 0;
        while (filled < length) {
          const { bytesRead } = await file.read(buffer, filled, length - filled, offset + filled);
          if (!bytesRead) throw new Error(`Unexpected end of ${asset.name}`);
          filled += bytesRead;
        }
        const partNumber = index + 1;
        const response = await checkedFetch(uploadUrl(asset, 'mpu-uploadpart', { uploadId, partNumber }), {
          method: 'PUT',
          headers: { authorization: `Bearer ${token}` },
          body: buffer,
        });
        completedParts[index] = await response.json();
        console.log(`  ${asset.name}: part ${partNumber}/${partCount}`);
      }
    }
    await Promise.all(Array.from({ length: Math.min(uploadConcurrency, partCount) }, worker));
    await checkedFetch(uploadUrl(asset, 'mpu-complete', { uploadId }), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ parts: completedParts }),
    });
  } catch (error) {
    try {
      await checkedFetch(uploadUrl(asset, 'mpu-abort', { uploadId }), {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
      });
    } catch {}
    throw error;
  } finally {
    await file.close();
  }
}

async function remoteMatches(asset) {
  const stat = await fs.promises.stat(asset.file);
  const response = await fetch(`${updateOrigin}/${prefix}/${asset.name}`, { method: 'HEAD' });
  if (!response.ok || Number(response.headers.get('content-length')) !== stat.size) return false;
  const local = await fs.promises.open(asset.file, 'r');
  const expected = Buffer.alloc(32);
  try { await local.read(expected, 0, 32, 17); } finally { await local.close(); }
  const range = await fetch(`${updateOrigin}/${prefix}/${asset.name}`, { headers: { range: 'bytes=17-48' } });
  return range.status === 206 && Buffer.from(await range.arrayBuffer()).equals(expected);
}

async function upload(asset, token) {
  const { size } = await fs.promises.stat(asset.file);
  console.log(`Uploading ${asset.name} (${(size / 1048576).toFixed(1)} MiB)`);
  if (size >= multipartThreshold) await uploadMultipart(asset, token, size);
  else await uploadSmall(asset, token);
}

async function verifyRemote() {
  const response = await checkedFetch(new URL(`${MANIFEST_PATH}?t=${Date.now()}`, updateOrigin), {
    headers: { 'cache-control': 'no-cache' },
  });
  const remotePayload = verifyManifest(await response.json());
  if (JSON.stringify(remotePayload) !== JSON.stringify(payload)) {
    throw new Error('Remote Zyn runtime manifest differs from the signed local manifest.');
  }
  for (const item of runtimeItems) {
    const local = assets.find(asset => asset.name === item.archive);
    if (!(await remoteMatches(local))) throw new Error(`${item.archive}: remote verification failed.`);
    console.log(`verified ${item.archive}`);
  }
}

async function main() {
  for (const asset of assets) if (!fs.existsSync(asset.file)) throw new Error(`Missing runtime artifact: ${asset.file}`);
  let token;
  try {
    token = execFileSync('security', [
      'find-generic-password', '-a', keychainAccount, '-s', keychainService, '-w',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    throw new Error('Zyn R2 upload credential is missing. Configure the update credential before publishing runtimes.');
  }

  for (const asset of assets.filter(item => !item.metadata)) {
    if (await remoteMatches(asset)) console.log(`Skipping unchanged ${asset.name}`);
    else await upload(asset, token);
  }
  for (const asset of assets.filter(item => item.metadata)) await upload(asset, token);
  await verifyRemote();
  console.log(`Zyn runtimes are live at ${updateOrigin}${MANIFEST_PATH}`);
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
