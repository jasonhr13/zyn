#!/usr/bin/env node
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const contract = require(path.join(projectRoot, 'config', 'runtime-contract.json'));
const version = contract.product.version;
const dist = path.join(projectRoot, 'release', 'dist', 'windows-x64');
const updateOrigin = (process.env.ZYN_UPDATE_ORIGIN || 'https://updates.zynbot.app').replace(/\/+$/, '');
const uploadOrigin = (process.env.ZYN_UPLOAD_ORIGIN || updateOrigin).replace(/\/+$/, '');
const prefix = process.env.ZYN_R2_PREFIX || 'windows';
const keychainAccount = process.env.ZYN_UPDATE_KEYCHAIN_ACCOUNT || 'zyn-updates';
const keychainService = process.env.ZYN_UPDATE_KEYCHAIN_SERVICE || 'com.thwebco.zyn.r2-upload';
const multipartThreshold = 64 * 1024 * 1024;
const partSize = 32 * 1024 * 1024;
const uploadConcurrency = 3;
const installerName = `Zyn-Setup-${version}-x64.exe`;
const assets = [
  { name: installerName, type: 'application/vnd.microsoft.portable-executable' },
  { name: `${installerName}.blockmap`, type: 'application/octet-stream' },
  { name: 'latest.yml', type: 'text/yaml; charset=utf-8', metadata: true },
].map(asset => ({ ...asset, file: path.join(dist, asset.name) }));

function uploadUrl(asset, action, extra = {}) {
  const url = new URL(`/__upload/${prefix}/${asset.name}`, uploadOrigin);
  url.searchParams.set('action', action);
  for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, String(value));
  return url;
}
function objectHeaders(asset, token) {
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
    headers: objectHeaders(asset, token),
    body: await fs.promises.readFile(asset.file),
  });
}
async function uploadMultipart(asset, token, size) {
  const created = await checkedFetch(uploadUrl(asset, 'mpu-create'), {
    method: 'POST',
    headers: objectHeaders(asset, token),
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
async function upload(asset, token) {
  const { size } = await fs.promises.stat(asset.file);
  console.log(`\nUploading ${asset.name} (${(size / 1048576).toFixed(1)} MiB)`);
  if (size >= multipartThreshold) await uploadMultipart(asset, token, size);
  else await uploadSmall(asset, token);
}

async function main() {
  const missing = assets.filter(asset => !fs.existsSync(asset.file));
  if (missing.length) throw new Error(`Missing Windows release files:\n${missing.map(asset => asset.file).join('\n')}`);
  const metadata = fs.readFileSync(path.join(dist, 'latest.yml'), 'utf8');
  if (!new RegExp(`^version:\\s*${version.replaceAll('.', '\\.')}\\s*$`, 'm').test(metadata)
    || !metadata.includes(installerName)) {
    throw new Error(`latest.yml does not advertise Zyn ${version} and ${installerName}.`);
  }
  let token;
  try {
    token = execFileSync('security', [
      'find-generic-password', '-a', keychainAccount, '-s', keychainService, '-w',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    throw new Error('The Cloudflare R2 upload credential is missing from Keychain.');
  }
  execFileSync(process.execPath, [path.join(__dirname, 'verify-zyn-windows-release.cjs')], {
    cwd: projectRoot,
    stdio: 'inherit',
  });
  for (const asset of assets.filter(item => !item.metadata)) await upload(asset, token);
  for (const asset of assets.filter(item => item.metadata)) await upload(asset, token);
  const live = await (await checkedFetch(new URL(`/${prefix}/latest.yml?t=${Date.now()}`, updateOrigin), {
    headers: { 'cache-control': 'no-cache' },
  })).text();
  if (!live.includes(`version: ${version}`) || !live.includes(installerName)) {
    throw new Error(`The live Windows feed does not advertise Zyn ${version}.`);
  }
  console.log(`\nZyn ${version} Windows x64 is live at ${updateOrigin}/${prefix}/latest.yml`);
}

main().catch(error => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
