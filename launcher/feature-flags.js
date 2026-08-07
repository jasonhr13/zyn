'use strict';

// Control-plane work is introduced behind explicit release flags. Each release enables one
// independently testable slice while every later phase remains dormant.
const CONTROL_PLANE_RELEASE = 'R3';

const FEATURES = Object.freeze({
  designShell: true,
  taskGroups: true,
  licenseObserve: true,
  licenseEnforce: false,
  apiModuleAccess: false,
  cloudBackup: false,
  taskScheduling: false,
  isolatedRenderer: false,
});

module.exports = { CONTROL_PLANE_RELEASE, FEATURES };
