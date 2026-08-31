#!/usr/bin/env node
'use strict';

const {
  DEFAULT_UPDATE_ORIGIN,
  normalizedOrigin,
  publishEngineReleaseNotification,
  readUploadCredential,
} = require('./zyn-engine-release-notification-lib.cjs');

async function main() {
  const uploadOrigin = normalizedOrigin(
    process.env.ZYN_UPLOAD_ORIGIN || process.env.ZYN_UPDATE_ORIGIN || DEFAULT_UPDATE_ORIGIN,
  );
  const result = await publishEngineReleaseNotification({
    token: readUploadCredential(),
    uploadOrigin,
  });
  console.log(
    `Zyn engine ${result.version} Discord message ${result.messageId} was `
    + `${result.duplicate ? 'already present' : 'posted'}.`,
  );
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
