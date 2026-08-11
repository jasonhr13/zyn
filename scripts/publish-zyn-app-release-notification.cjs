#!/usr/bin/env node
'use strict';

const path = require('node:path');
const {
  DEFAULT_UPDATE_ORIGIN,
  appReleaseNotesPath,
  assertAppVersion,
  normalizedOrigin,
  publishAppReleaseNotification,
  readAppReleaseNotes,
  readUploadCredential,
} = require('./zyn-app-release-notification-lib.cjs');

const projectRoot = path.resolve(__dirname, '..');
const contract = require(path.join(projectRoot, 'config', 'runtime-contract.json'));

async function main() {
  if (process.argv.length > 3) {
    throw new Error('Usage: node scripts/publish-zyn-app-release-notification.cjs [version]');
  }
  const version = assertAppVersion(process.argv[2] || contract.product.version);
  const notes = readAppReleaseNotes(appReleaseNotesPath(projectRoot, version), version);
  const uploadOrigin = normalizedOrigin(
    process.env.ZYN_UPLOAD_ORIGIN || process.env.ZYN_UPDATE_ORIGIN || DEFAULT_UPDATE_ORIGIN,
  );
  const result = await publishAppReleaseNotification({
    token: readUploadCredential(),
    releaseNotes: notes,
    uploadOrigin,
  });
  if (result.pending) {
    console.log(`Zyn ${version} notification is pending until every app platform feed is live.`);
    return;
  }
  console.log(
    `Zyn ${version} Discord message ${result.messageId} was ${result.duplicate ? 'already present' : 'posted'}.`,
  );
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  });
}

module.exports = { main };
