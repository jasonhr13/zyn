#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

const accounts = read('frontend/src/components/pages/accounts.js');
const sidebar = read('frontend/src/components/sidebar.js');
const routes = read('frontend/src/components/page-handler.js');
const settings = read('frontend/src/components/pages/settings.js');
const target = read('frontend/src/components/pages/target.js');
const taskGroups = read('frontend/src/components/pages/task-groups.js');
const inlineOtp = read('frontend/src/components/target-otp-input.js');

assert.doesNotMatch(accounts, /SITE_TABS/);
assert.doesNotMatch(accounts, /account-site-picker/);
assert.match(accounts, /addAccountsBulk'[\s\S]*site: this.state.accountSite \|\| 'target'/);
assert.match(accounts, /<option value="target">Target<\/option>/);
assert.match(accounts, /walmartAccess && <option value="walmart">Walmart<\/option>/);
assert.match(accounts, /saved\.accountSite === 'walmart'/);
assert.match(accounts, /previousState\.accountSite === this.state.accountSite/);
const createProfile = read('frontend/src/components/pages/profiles-components/create-modal.js');
assert.match(createProfile, /<option value="walmart">Walmart<\/option>/);
assert.match(accounts, /filter\(isTargetAccount\)/);
assert.match(accounts, /ipcRenderer\.sendSync\('updateAccount', \{ id: editingId, data \}\)/);
assert.match(accounts, /Leave blank to keep the saved password/);
assert.match(accounts, /data\.profileId = matchingProfile \? matchingProfile\.id : null/);
assert.match(accounts, /if \(emailChanged \|\| passwordChanged\) data\.cookie = ''/);

assert.match(sidebar, /to:\s*'\/task-groups'[\s\S]*label:\s*'Target'[\s\S]*section:\s*'Tasks'/);
assert.match(sidebar, /to:\s*'\/pokemoncenter'[\s\S]*label:\s*'Pokémon Center'[\s\S]*taskType:\s*'pokemoncenter'/);
assert.match(sidebar, /activeRoutes:\s*\['\/task-groups',\s*'\/target'\]/);
assert.doesNotMatch(sidebar, /label:\s*'Tasks'[\s\S]*to:\s*'\/modules'/);
assert.match(routes, /<Sidebar taskTypes=\{license\.taskTypes \|\| \{\}\} \/>/);
assert.match(sidebar, /Update to v\{update\.version\}/);
assert.match(sidebar, /background:\s*'var\(--ok\)'[\s\S]{0,80}color:\s*'#000'/);
assert.doesNotMatch(sidebar, /label:\s*'Generate'/);

for (const retired of ['tasks', 'generate', 'pbandai', 'round1', 'riotgames']) {
  assert.doesNotMatch(routes, new RegExp(`(?:pages/|path=")${retired}`));
}
assert.match(routes, /pages\/modules/);
assert.match(routes, /pages\/pokemoncenter/);
assert.match(routes, /pages\/walmart/);
assert.match(routes, /license\.taskTypes[\s\S]*pokemoncenter/);
assert.match(routes, /license\.taskTypes && license\.taskTypes\.walmart/);
assert.match(sidebar, /taskType:\s*'walmart'/);
assert.match(routes, /<Redirect to="\/modules" \/>/);
assert.doesNotMatch(routes, /OtpBanner|otp-banner/,
  'login-code entry must not return as a global overlay');
assert.match(target, /otpRequest[\s\S]{0,160}<TargetOtpInput request=\{otpRequest\}/,
  'legacy Target task rows do not replace their status with OTP entry');
assert.match(taskGroups, /otpRequest \? <TargetOtpInput request=\{otpRequest\} \/> : <StatusBadge/,
  'Target group task rows do not replace their status with OTP entry');
assert.match(taskGroups, /<TargetOtpInput request=\{otpRequest\} large \/>/,
  'selected task detail does not expose its pending OTP entry');
assert.match(inlineOtp, /sendSync\('targetSubmitOtp', \{ email: request\.email, code \}\)/);
assert.match(inlineOtp, /autoComplete="one-time-code"/);
assert.match(inlineOtp, /target-otp-message[\s\S]*role="status"[\s\S]*aria-live="polite"/,
  'the OTP control does not surface automatic mailbox progress');
assert.match(inlineOtp, /phase === 'submitting'[\s\S]*disabled=\{submitting\}/,
  'the OTP control does not distinguish automatic lookup from code submission');
assert.match(taskGroups, /Target order-limit history stay unchanged[\s\S]*type: 'targetTaskReset'/,
  'Target task groups do not provide a safe completed-run reset');
assert.match(taskGroups, /icon-action-reset[\s\S]*Reset Task/,
  'Target reset is not available from both the task row and detail view');

assert.match(settings, /Target workspace/);
assert.match(settings, /pokemonCenterAccess \? 'Enabled' : 'Not included'/);
assert.match(settings, /Pokémon Center/);
assert.match(settings, /hcaptchaAutosolve/);
assert.match(settings, /AutoSolve hCaptcha/);
assert.match(settings, /<span>Walmart<\/span>/);
assert.doesNotMatch(settings, /Bandai|Round1|Riot Games|Secret Lair|Auto Buy Profiles|Solver Keys/);

const extensionSettings = settings.indexOf('Target — Browser Extension Harvesters');
const operatorSettings = settings.indexOf('{operatorMode && (<>');
assert.ok(extensionSettings >= 0 && extensionSettings < operatorSettings,
  'Chrome extension harvester settings must be visible without operator mode');
const publicHarvesterSettings = settings.slice(extensionSettings, operatorSettings);
assert.match(publicHarvesterSettings, /Browser extension harvesting/);
assert.match(publicHarvesterSettings, /value=\{targetHarvesterExtensionIds\}/);
assert.match(publicHarvesterSettings, /Chrome, Brave, or multiple browser profiles at once/,
  'Settings must explain simultaneous multi-browser harvesting');
assert.match(publicHarvesterSettings, /Browser extension IDs/);
assert.match(publicHarvesterSettings, /extensionIdsError/);
assert.match(publicHarvesterSettings, /role="alert"/);
assert.match(settings, /targetHarvesterExtensionIds\.split\('\\n'\)\[0\]/,
  'saving multiple IDs must preserve the legacy singular setting');
assert.match(settings,
  /const targetHarvesterExtensionIds = !extensionModeEnabled && parsedExtensionIds\.error[\s\S]{0,100}\? previousExtensionIds[\s\S]{0,100}: parsedExtensionIds\.normalized/,
  'turning harvesting off must preserve the prior valid IDs when the hidden draft is invalid');
assert.match(settings, /ipcRenderer\.send\('resetHarvesterExtensionActivity'\)/,
  'changing extension settings must reset stale bridge activity');
const advancedHarvesterSettings = settings.slice(operatorSettings, settings.indexOf('Email / OTP', operatorSettings));
assert.doesNotMatch(advancedHarvesterSettings, /value=\{shapeMethod\}|value=\{targetHarvesterExtensionIds\}/,
  'Chrome extension controls must not remain operator-only');
assert.match(advancedHarvesterSettings, /Show task and engine logs/);
assert.match(advancedHarvesterSettings, /toggleOperatorLogs/);

console.log('Target and Pokemon Center UI smoke test passed');
