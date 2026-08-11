const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  appReleaseNotesPath,
  publishAppReleaseNotification,
  readAppReleaseNotes,
} = require('./zyn-app-release-notification-lib.cjs');

const projectRoot = path.join(__dirname, '..');
const contract = require(path.join(projectRoot, 'config', 'runtime-contract.json'));
const arch = String(process.argv[2] || '').toLowerCase() === 'x86_64' ? 'x64' : String(process.argv[2] || '').toLowerCase();
if (!['arm64', 'x64'].includes(arch)) {
  console.error('Usage: node scripts/upload-zyn-macos-release.cjs <arm64|x64>');
  process.exit(2);
}
const version = contract.product.version;
const dist = path.join(projectRoot, 'release', 'dist', arch);
const updateOrigin = (process.env.ZYN_UPDATE_ORIGIN
  || 'https://updates.zynbot.app').replace(/\/+$/, '');
const uploadOrigin = (process.env.ZYN_UPLOAD_ORIGIN || updateOrigin).replace(/\/+$/, '');
const prefix = process.env.ZYN_R2_PREFIX || `mac/${arch}`;
const keychainAccount = process.env.ZYN_UPDATE_KEYCHAIN_ACCOUNT || 'zyn-updates';
const keychainService = process.env.ZYN_UPDATE_KEYCHAIN_SERVICE || 'com.thwebco.zyn.r2-upload';
const multipartThreshold = 64 * 1024 * 1024;
const partSize = 32 * 1024 * 1024;
const uploadConcurrency = 3;

const assets = [
  { name: `Zyn-${version}-${arch}.dmg`, type: 'application/x-apple-diskimage' },
  { name: `Zyn-${version}-${arch}.zip`, type: 'application/zip' },
  { name: 'latest-mac.yml', type: 'text/yaml; charset=utf-8', metadata: true },
].map((asset) => ({ ...asset, file: path.join(dist, asset.name) }));

function fail(message) {
  console.error(message);
  process.exit(1);
}

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
  const body = await fs.promises.readFile(asset.file);
  await checkedFetch(uploadUrl(asset, 'put'), {
    method: 'PUT',
    headers: objectHeaders(asset, token),
    body,
  });
}

async function uploadMultipart(asset, token, size) {
  const createResponse = await checkedFetch(uploadUrl(asset, 'mpu-create'), {
    method: 'POST',
    headers: objectHeaders(asset, token),
  });
  const { uploadId } = await createResponse.json();
  if (!uploadId) throw new Error(`Cloudflare did not return an uploadId for ${asset.name}`);

  const partCount = Math.ceil(size / partSize);
  const completedParts = new Array(partCount);
  const file = await fs.promises.open(asset.file, 'r');
  let nextPart = 0;

  try {
    async function uploadWorker() {
      while (true) {
        const index = nextPart++;
        if (index >= partCount) return;
        const offset = index * partSize;
        const length = Math.min(partSize, size - offset);
        const buffer = Buffer.allocUnsafe(length);
        let filled = 0;
        while (filled < length) {
          const { bytesRead } = await file.read(buffer, filled, length - filled, offset + filled);
          if (!bytesRead) throw new Error(`Unexpected end of file while reading ${asset.name}`);
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

    await Promise.all(Array.from({ length: Math.min(uploadConcurrency, partCount) }, uploadWorker));
    await checkedFetch(uploadUrl(asset, 'mpu-complete', { uploadId }), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
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
  console.log(`\nUploading ${asset.name} (${(size / 1024 / 1024).toFixed(1)} MiB)`);
  if (size >= multipartThreshold) await uploadMultipart(asset, token, size);
  else await uploadSmall(asset, token);
}

async function main() {
  const missing = assets.filter((asset) => !fs.existsSync(asset.file));
  if (missing.length) {
    fail(`Missing local macOS release files:\n${missing.map((asset) => asset.file).join('\n')}\nRun node scripts/release-zyn-macos.cjs ${arch} first.`);
  }

  const updateMetadata = fs.readFileSync(path.join(dist, 'latest-mac.yml'), 'utf8');
  if (!new RegExp(`^version:\\s*${version.replaceAll('.', '\\.')}$`, 'm').test(updateMetadata)) {
    fail(`latest-mac.yml does not advertise package version ${version}. Rebuild the release.`);
  }
  for (const asset of assets.filter((item) => item.name.endsWith('.zip') || item.name.endsWith('.dmg'))) {
    if (!updateMetadata.includes(asset.name)) {
      fail(`latest-mac.yml does not reference ${asset.name}. Refusing to publish an incomplete feed.`);
    }
  }
  const releaseNotes = readAppReleaseNotes(appReleaseNotesPath(projectRoot, version), version);

  let token;
  try {
    token = execFileSync('security', [
      'find-generic-password', '-a', keychainAccount, '-s', keychainService, '-w',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    fail('The existing Cloudflare R2 upload credential is missing from Keychain. Re-run the update credential setup first.');
  }

  execFileSync(process.execPath, [path.join(__dirname, 'verify-zyn-macos-release.cjs'), arch], {
    cwd: projectRoot,
    stdio: 'inherit',
  });

  for (const asset of assets.filter((item) => !item.metadata)) await upload(asset, token);
  for (const asset of assets.filter((item) => item.metadata)) await upload(asset, token);

  const liveMetadata = await (await checkedFetch(new URL(`/${prefix}/latest-mac.yml`, updateOrigin), {
    headers: { 'cache-control': 'no-cache' },
  })).text();
  if (!liveMetadata.includes(`version: ${version}`)) {
    throw new Error(`The live feed does not advertise Zyn ${version} after upload.`);
  }
  console.log(`\nZyn ${version} (${arch}) is live at ${updateOrigin}/${prefix}/latest-mac.yml`);
  const notification = await publishAppReleaseNotification({
    token,
    releaseNotes,
    uploadOrigin,
  });
  if (notification.pending) {
    console.log(`Zyn ${version} notification is pending until every app platform feed is live.`);
  } else {
    console.log(
      `Zyn ${version} Discord message ${notification.messageId} was `
      + `${notification.duplicate ? 'already present' : 'posted'}.`,
    );
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
