'use strict';

// Control-plane work is introduced behind explicit release flags. R0 intentionally keeps every
// flag off, making this module observable build metadata rather than a behavior change. Later
// releases enable one independently testable slice at a time.
const CONTROL_PLANE_RELEASE = 'R0';

const FEATURES = Object.freeze({
  designShell: false,
  taskGroups: false,
  licenseObserve: false,
  licenseEnforce: false,
  apiModuleAccess: false,
  cloudBackup: false,
  taskScheduling: false,
  isolatedRenderer: false,
});

module.exports = { CONTROL_PLANE_RELEASE, FEATURES };
