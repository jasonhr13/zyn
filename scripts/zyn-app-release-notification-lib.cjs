#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const APP_RELEASE_NOTES_SCHEMA_VERSION = 1;
const DEFAULT_UPDATE_ORIGIN = 'https://updates.zynbot.app';
const DEFAULT_KEYCHAIN_ACCOUNT = 'zyn-updates';
const DEFAULT_KEYCHAIN_SERVICE = 'com.thwebco.zyn.r2-upload';
const MIN_NOTES = 3;
const MAX_NOTES = 6;
const MIN_NOTE_LENGTH = 10;
const MAX_NOTE_LENGTH = 120;
const RELEASE_NOTES_KEYS = Object.freeze(['notes', 'schemaVersion', 'version']);

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

function assertAppVersion(value) {
  const version = String(value || '');
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version)) {
    throw new Error('App release-note version must be a three-part semantic version.');
  }
  return version;
}

function validateNote(note, index) {
  if (typeof note !== 'string' || note !== note.trim() || note.length < MIN_NOTE_LENGTH
    || note.length > MAX_NOTE_LENGTH) {
    throw new Error(
      `App release note ${index + 1} must be a trimmed string of ${MIN_NOTE_LENGTH}-${MAX_NOTE_LENGTH} characters.`,
    );
  }
  if (/[\u0000-\u001f\u007f]/u.test(note)) {
    throw new Error(`App release note ${index + 1} must be a single line without control characters.`);
  }
  if (/@|<@|`/.test(note)) {
    throw new Error(`App release note ${index + 1} cannot contain Discord mention or code syntax.`);
  }
  return note;
}

function validateAppReleaseNotes(value, expectedVersion) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('App release notes must contain an object.');
  }
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(RELEASE_NOTES_KEYS)) {
    throw new Error(`App release notes must contain exactly: ${RELEASE_NOTES_KEYS.join(', ')}.`);
  }
  if (value.schemaVersion !== APP_RELEASE_NOTES_SCHEMA_VERSION) {
    throw new Error(`App release-note schema must be ${APP_RELEASE_NOTES_SCHEMA_VERSION}.`);
  }
  const version = assertAppVersion(value.version);
  if (expectedVersion !== undefined && version !== assertAppVersion(expectedVersion)) {
    throw new Error(`App release notes are for ${version}, but this release is ${expectedVersion}.`);
  }
  if (!Array.isArray(value.notes) || value.notes.length < MIN_NOTES || value.notes.length > MAX_NOTES) {
    throw new Error(`App release notes must contain ${MIN_NOTES}-${MAX_NOTES} entries.`);
  }
  value.notes.forEach(validateNote);
  if (new Set(value.notes.map(note => note.toLocaleLowerCase('en-US'))).size !== value.notes.length) {
    throw new Error('App release notes cannot contain duplicate entries.');
  }
  return value;
}

function appReleaseNotesPath(projectRoot, version) {
  return path.join(path.resolve(projectRoot), 'release-notes', 'app', `${assertAppVersion(version)}.json`);
}

function readAppReleaseNotes(file, expectedVersion) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read app release notes ${file}: ${error.message}`);
  }
  return validateAppReleaseNotes(value, expectedVersion);
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

function validatePendingResult(value, releaseNotes) {
  if (value.version !== releaseNotes.version
      || value.published !== Boolean(value.ready)
      || typeof value.ready !== 'boolean'
      || value.pending !== true
      || value.notified !== false) {
    throw new Error('App release notification endpoint returned an invalid pending response.');
  }
  return {
    pending: true,
    notified: false,
    version: releaseNotes.version,
  };
}

function validateSuccessResult(value, releaseNotes) {
  if (value.version !== releaseNotes.version
    || value.published !== true || value.ready !== true || value.pending !== false
    || value.notified !== true
    || typeof value.duplicate !== 'boolean' || typeof value.messageId !== 'string'
    || !/^\d+$/.test(value.messageId)) {
    throw new Error('App release notification endpoint did not confirm its Discord message.');
  }
  return {
    pending: false,
    notified: true,
    duplicate: value.duplicate,
    version: releaseNotes.version,
    messageId: value.messageId,
  };
}

async function publishAppReleaseNotification({
  fetchImpl = fetch,
  token,
  releaseNotes,
  uploadOrigin = DEFAULT_UPDATE_ORIGIN,
}) {
  const notes = validateAppReleaseNotes(releaseNotes);
  if (typeof token !== 'string' || !token.trim()) {
    throw new Error('The Cloudflare R2 upload credential is empty.');
  }
  const origin = normalizedOrigin(uploadOrigin);
  let response;
  try {
    response = await fetchImpl(new URL('/__publish/app', origin), {
      method: 'POST',
      redirect: 'error',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(notes),
    });
  } catch {
    throw new Error('App release notification request could not reach the updates service.');
  }

  if (response.status === 202) {
    return validatePendingResult(
      await responseJson(response, 'App release notification request'),
      notes,
    );
  }
  if (response.status === 200) {
    return validateSuccessResult(
      await responseJson(response, 'App release notification request'),
      notes,
    );
  }
  if (response.status === 409) {
    throw new Error(
      `Zyn ${notes.version} already has a different app-release notification receipt. Review the committed release notes before retrying.`,
    );
  }
  if (response.status === 502) {
    throw new Error(
      `Zyn ${notes.version} is live, but its Discord notification failed. Rerun scripts/publish-zyn-app-release-notification.cjs to retry without uploading the apps again.`,
    );
  }
  throw new Error(`App release notification request failed (${response.status}).`);
}

module.exports = {
  APP_RELEASE_NOTES_SCHEMA_VERSION,
  DEFAULT_UPDATE_ORIGIN,
  MAX_NOTES,
  MAX_NOTE_LENGTH,
  MIN_NOTE_LENGTH,
  MIN_NOTES,
  appReleaseNotesPath,
  assertAppVersion,
  normalizedOrigin,
  publishAppReleaseNotification,
  readAppReleaseNotes,
  readUploadCredential,
  validateAppReleaseNotes,
};
