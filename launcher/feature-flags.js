'use strict';

// Release capabilities stay explicit so every packaged build can be verified independently.
const APP_RELEASE = 'R8.30';

const FEATURES = Object.freeze({
  designShell: true,
  taskGroups: true,
  licenseObserve: true,
  licenseEnforce: true,
  apiModuleAccess: true,
  profileImap: true,
  managedProxies: true,
  cloudBackup: true,
  taskScheduling: true,
  isolatedRenderer: false,
});

module.exports = { APP_RELEASE, FEATURES };
