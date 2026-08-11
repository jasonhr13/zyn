#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  EXTENSION_DIRECTORY,
  EXTENSION_OUTPUT_DIRECTORY,
  METADATA_FILENAME,
  readReleaseMetadata,
  sha256File,
  trackedExtensionFiles,
  validateReleaseMetadata,
  verifyExtensionRelease,
} = require('./zyn-extension-release-lib.cjs');

const projectRoot = path.resolve(__dirname, '..');
const DEFAULT_UPDATE_ORIGIN = 'https://updates.zynbot.app';
const DEFAULT_SITE_ORIGIN = 'https://zynbot.app';
const keychainAccount = process.env.ZYN_UPDATE_KEYCHAIN_ACCOUNT || 'zyn-updates';
const keychainService = process.env.ZYN_UPDATE_KEYCHAIN_SERVICE || 'com.thwebco.zyn.r2-upload';

function normalizedOrigin(value, label) {
  const url = new URL(String(value || ''));
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.pathname !== '/'
    || url.search || url.hash) {
    throw new Error(`${label} must be an HTTP(S) origin.`);
  }
  return url.origin;
}

function releaseUrls(metadata, {
  updateOrigin = DEFAULT_UPDATE_ORIGIN,
  siteOrigin = DEFAULT_SITE_ORIGIN,
} = {}) {
  const core = validateReleaseMetadata(metadata);
  const updates = normalizedOrigin(updateOrigin, 'Zyn update origin');
  const site = normalizedOrigin(siteOrigin, 'Zyn site origin');
  return {
    downloadUrl: `${site}/download/extension`,
    versionedDownloadUrl: `${site}/download/extension/${core.version}`,
    artifactUrl: `${updates}/extension/${core.filename}`,
  };
}

function validateLiveMetadata(value) { return validateReleaseMetadata(value); }

function parseJson(text, label) {
  try { return JSON.parse(text); }
  catch { throw new Error(`${label} did not return JSON.`); }
}

async function responseBody(response, label) {
  return parseJson(await response.text(), label);
}

function validatePublishResult(value, metadata, responseOk, {
  siteOrigin = DEFAULT_SITE_ORIGIN,
} = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Extension publish endpoint returned an invalid result.');
  }
  if (value.published !== true || value.version !== metadata.version) {
    throw new Error('Extension publish endpoint did not confirm the requested version.');
  }
  const site = normalizedOrigin(siteOrigin, 'Zyn site origin');
  if (value.downloadUrl !== `${site}/download/extension/${metadata.version}`) {
    throw new Error('Extension publish endpoint returned a non-canonical download URL.');
  }
  if (typeof value.duplicate !== 'boolean') {
    throw new Error('Extension publish endpoint omitted duplicate status.');
  }
  if (responseOk) {
    const keys = ['downloadUrl', 'duplicate', 'messageId', 'notified', 'published', 'version'];
    if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys)) {
      throw new Error('Extension publish success result has unexpected fields.');
    }
    if (value.notified !== true || typeof value.messageId !== 'string' || !/^\d+$/.test(value.messageId)) {
      throw new Error('Extension publish endpoint did not confirm its Discord notification.');
    }
  } else {
    const keys = ['downloadUrl', 'duplicate', 'error', 'notified', 'published', 'version'];
    if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys)
      || value.notified !== false || value.error !== 'Discord notification failed.') {
      throw new Error('Extension publish failure result has an unexpected shape.');
    }
  }
  return value;
}

async function fetchJson(fetchImpl, url, options, label) {
  const response = await fetchImpl(url, options);
  if (!response.ok) throw new Error(`${label} failed (${response.status}).`);
  return responseBody(response, label);
}

function requireHeader(response, name, expected, label) {
  const actual = response.headers.get(name);
  if (actual !== expected) throw new Error(`${label} returned ${name}=${JSON.stringify(actual)}; expected ${JSON.stringify(expected)}.`);
}

async function verifyRedirect(fetchImpl, from, expected, label) {
  const response = await fetchImpl(from, {
    method: 'HEAD',
    redirect: 'manual',
    headers: { 'cache-control': 'no-cache' },
  });
  if (response.status !== 302) throw new Error(`${label} did not return a 302 redirect.`);
  requireHeader(response, 'location', expected, label);
}

async function verifyLiveRelease(fetchImpl, metadata, {
  updateOrigin = DEFAULT_UPDATE_ORIGIN,
  siteOrigin = DEFAULT_SITE_ORIGIN,
} = {}) {
  const urls = releaseUrls(metadata, { updateOrigin, siteOrigin });
  const updates = normalizedOrigin(updateOrigin, 'Zyn update origin');
  const live = await fetchJson(
    fetchImpl,
    `${updates}/extension/${METADATA_FILENAME}?t=${Date.now()}`,
    { headers: { 'cache-control': 'no-cache' }, redirect: 'error' },
    'Live extension metadata request',
  );
  validateLiveMetadata(live);
  for (const [key, expectedValue] of Object.entries(metadata)) {
    if (live[key] !== expectedValue) {
      throw new Error(`Live extension metadata does not match the uploaded release at ${key}.`);
    }
  }

  const updatesStable = `${updates}/download/extension`;
  await verifyRedirect(fetchImpl, urls.downloadUrl, updatesStable, 'Zyn extension download');
  await verifyRedirect(fetchImpl, updatesStable, urls.artifactUrl, 'Zyn updates extension download');
  await verifyRedirect(
    fetchImpl,
    urls.versionedDownloadUrl,
    urls.artifactUrl,
    'Versioned Zyn extension download',
  );

  const head = await fetchImpl(urls.artifactUrl, {
    method: 'HEAD',
    redirect: 'error',
    headers: { 'cache-control': 'no-cache' },
  });
  if (!head.ok) throw new Error(`Versioned extension artifact HEAD failed (${head.status}).`);
  requireHeader(head, 'content-type', 'application/zip', 'Versioned extension artifact');
  requireHeader(head, 'content-length', String(metadata.size), 'Versioned extension artifact');
  requireHeader(head, 'x-zyn-sha256', metadata.sha256, 'Versioned extension artifact');
  requireHeader(
    head,
    'cache-control',
    'public, max-age=31536000, immutable',
    'Versioned extension artifact',
  );
  requireHeader(
    head,
    'content-disposition',
    'attachment; filename="Zyn-Harvester.zip"',
    'Versioned extension artifact',
  );

  const artifact = await fetchImpl(urls.artifactUrl, {
    headers: { 'cache-control': 'no-cache' },
    redirect: 'error',
  });
  if (!artifact.ok) throw new Error(`Versioned extension artifact download failed (${artifact.status}).`);
  const body = Buffer.from(await artifact.arrayBuffer());
  if (body.length !== metadata.size) throw new Error('Live extension artifact size is incorrect.');
  const digest = require('node:crypto').createHash('sha256').update(body).digest('hex');
  if (digest !== metadata.sha256) throw new Error('Live extension artifact SHA-256 is incorrect.');
  return urls;
}

async function uploadAndPublish({
  fetchImpl = fetch,
  token,
  zip,
  metadata,
  uploadOrigin = DEFAULT_UPDATE_ORIGIN,
  updateOrigin = DEFAULT_UPDATE_ORIGIN,
  siteOrigin = DEFAULT_SITE_ORIGIN,
}) {
  validateReleaseMetadata(metadata);
  if (!token) throw new Error('The Cloudflare R2 upload credential is empty.');
  const upload = normalizedOrigin(uploadOrigin, 'Zyn upload origin');
  const zipBody = await fs.promises.readFile(zip);
  if (zipBody.length !== metadata.size || sha256File(zip) !== metadata.sha256) {
    throw new Error('Local extension ZIP does not match its release metadata.');
  }

  const uploadUrl = new URL(`/__upload/extension/${metadata.filename}`, upload);
  uploadUrl.searchParams.set('action', 'put');
  const uploadResponse = await fetchImpl(uploadUrl, {
    method: 'PUT',
    redirect: 'error',
    headers: {
      authorization: `Bearer ${token}`,
      'content-length': String(metadata.size),
      'x-object-content-type': 'application/zip',
      'x-object-cache-control': 'public, max-age=31536000, immutable',
      'x-object-sha256': metadata.sha256,
    },
    body: zipBody,
  });
  if (!uploadResponse.ok) {
    throw new Error(`Extension ZIP upload failed (${uploadResponse.status}).`);
  }

  const publishResponse = await fetchImpl(new URL('/__publish/extension', upload), {
    method: 'POST',
    redirect: 'error',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(metadata),
  });
  const publishResult = await responseBody(publishResponse, 'Extension publish request');
  if (!publishResponse.ok && publishResult.published !== true) {
    throw new Error(`Extension publish request failed (${publishResponse.status}).`);
  }
  validatePublishResult(publishResult, metadata, publishResponse.ok, { siteOrigin });
  await verifyLiveRelease(fetchImpl, metadata, { updateOrigin, siteOrigin });
  if (!publishResponse.ok || publishResult.notified !== true) {
    throw new Error(
      `Zyn Harvester ${metadata.version} is live, but its Discord notification failed. Rerun this upload command to retry notification without bumping the version.`,
    );
  }
  return publishResult;
}

function uploadCredential() {
  try {
    return execFileSync('security', [
      'find-generic-password', '-a', keychainAccount, '-s', keychainService, '-w',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    throw new Error('The Cloudflare R2 upload credential is missing from Keychain.');
  }
}

async function main() {
  const outputRoot = path.join(projectRoot, EXTENSION_OUTPUT_DIRECTORY);
  const verified = verifyExtensionRelease({
    sourceRoot: path.join(projectRoot, EXTENSION_DIRECTORY),
    files: trackedExtensionFiles(projectRoot),
    outputRoot,
  });
  const metadata = readReleaseMetadata(path.join(outputRoot, METADATA_FILENAME));
  const updateOrigin = normalizedOrigin(
    process.env.ZYN_UPDATE_ORIGIN || DEFAULT_UPDATE_ORIGIN,
    'Zyn update origin',
  );
  const uploadOrigin = normalizedOrigin(process.env.ZYN_UPLOAD_ORIGIN || updateOrigin, 'Zyn upload origin');
  const siteOrigin = normalizedOrigin(process.env.ZYN_SITE_ORIGIN || DEFAULT_SITE_ORIGIN, 'Zyn site origin');
  console.log(`Uploading ${metadata.filename} (${(metadata.size / 1024).toFixed(1)} KiB)`);
  const result = await uploadAndPublish({
    token: uploadCredential(),
    zip: verified.zip,
    metadata,
    uploadOrigin,
    updateOrigin,
    siteOrigin,
  });
  console.log(
    `Zyn Harvester ${metadata.version} is live at ${result.downloadUrl} `
    + `and Discord message ${result.messageId} was ${result.duplicate ? 'already present' : 'posted'}.`,
  );
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  });
}

module.exports = {
  normalizedOrigin,
  releaseUrls,
  uploadAndPublish,
  validateLiveMetadata,
  validatePublishResult,
  verifyLiveRelease,
};
