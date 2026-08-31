#!/usr/bin/env node
'use strict';

const { execFileSync } = require('node:child_process');

const DEFAULT_UPDATE_ORIGIN = 'https://updates.zynbot.app';
const DEFAULT_KEYCHAIN_ACCOUNT = 'zyn-updates';
const DEFAULT_KEYCHAIN_SERVICE = 'com.thwebco.zyn.r2-upload';

function normalizedOrigin(value, label = 'Zyn upload origin') {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    throw new Error(`${label} must be an HTTP(S) origin.`);
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.pathname !== '/'
    || url.search || url.hash) {
    throw new Error(`${label} must be an HTTP(S) origin.`);
  }
  return url.origin;
}

function readUploadCredential({
  execFileSyncImpl = execFileSync,
  account = process.env.ZYN_UPDATE_KEYCHAIN_ACCOUNT || DEFAULT_KEYCHAIN_ACCOUNT,
  service = process.env.ZYN_UPDATE_KEYCHAIN_SERVICE || DEFAULT_KEYCHAIN_SERVICE,
} = {}) {
  let token;
  try {
    token = execFileSyncImpl('security', [
      'find-generic-password', '-a', account, '-s', service, '-w',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    throw new Error('The Cloudflare R2 upload credential is missing from Keychain.');
  }
  if (!token) throw new Error('The Cloudflare R2 upload credential in Keychain is empty.');
  return token;
}

async function responseJson(response, label) {
  let value;
  try {
    value = JSON.parse(await response.text());
  } catch {
    throw new Error(`${label} returned an invalid response.`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} returned an invalid response.`);
  }
  return value;
}

async function publishEngineReleaseNotification({
  fetchImpl = fetch,
  token,
  uploadOrigin = DEFAULT_UPDATE_ORIGIN,
} = {}) {
  if (typeof token !== 'string' || !token.trim()) {
    throw new Error('The Cloudflare R2 upload credential is empty.');
  }
  const origin = normalizedOrigin(uploadOrigin);
  let response;
  try {
    response = await fetchImpl(new URL('/__publish/engine', origin), {
      method: 'POST',
      redirect: 'error',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: '{}',
    });
  } catch {
    throw new Error('Engine release notification request could not reach the updates service.');
  }

  if (response.status === 200) {
    const value = await responseJson(response, 'Engine release notification request');
    if (value.published !== true || value.notified !== true
      || typeof value.duplicate !== 'boolean'
      || typeof value.version !== 'string'
      || typeof value.messageId !== 'string'
      || !/^\d+$/.test(value.messageId)) {
      throw new Error('Engine release notification endpoint did not confirm its Discord message.');
    }
    return {
      notified: true,
      duplicate: value.duplicate,
      version: value.version,
      messageId: value.messageId,
    };
  }
  if (response.status === 409) {
    throw new Error('The live engine runtime is not a complete, matching 1.x.x release across Mac and Windows.');
  }
  if (response.status === 502) {
    throw new Error(
      'The engine is live, but its Discord notification failed. Rerun scripts/publish-zyn-engine-release-notification.cjs to retry without uploading again.',
    );
  }
  throw new Error(`Engine release notification request failed (${response.status}).`);
}

module.exports = {
  DEFAULT_UPDATE_ORIGIN,
  normalizedOrigin,
  publishEngineReleaseNotification,
  readUploadCredential,
};
