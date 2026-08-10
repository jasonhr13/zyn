#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

const profiles = read('frontend/src/components/pages/profiles.js');
const styles = read('frontend/src/App.css');
const control = read('launcher/profile-imap-control.js');
const bootstrap = read('launcher/bootstrap.js');

assert.match(profiles, /className="profile-groups-sidebar"/,
  'Profiles does not render its nested group sidebar');
assert.match(profiles, /className={`profile-row\$\{isSelected/,
  'Profiles are not rendered as selectable rows');
assert.doesNotMatch(profiles, /profile-grid|profile-card/,
  'The retired profile card grid is still rendered');
assert.match(profiles, /groups: this\.isCustomGroup\(group\) \? \[group\] : \[\]/,
  'new profiles are not scoped to the selected group');
assert.match(profiles, /Add to group…/,
  'existing profiles cannot be assigned from the row workspace');
assert.match(profiles, /Remove from \{activeGroup\}/,
  'profiles cannot be removed from the active group');
assert.doesNotMatch(profiles, /memberships\.slice|const memberships = profileGroups\(profile\)/,
  'profile rows still repeat group memberships already shown by the sidebar');
assert.match(styles, /\.profiles-shell\s*\{[^}]*grid-template-columns:/,
  'Profiles does not define the nested sidebar layout');
assert.match(styles, /\.profile-row\s*\{[\s\S]{0,280}grid-template-columns:/,
  'Profile rows do not define a table-like column layout');

for (const method of ['createProfileGroup', 'renameProfileGroup', 'deleteProfileGroup']) {
  assert.match(control, new RegExp(`function ${method}\\(`), `profile storage omits ${method}`);
  assert.match(bootstrap, new RegExp(`'${method}'`), `profile group IPC omits ${method}`);
}
assert.match(control, /profileGroups: normalizeProfileGroups\(groups\)/,
  'empty groups are not persisted independently of profiles');

const activeHelperStart = profiles.indexOf('function activeTaskProfileIds');
const activeHelperEnd = profiles.indexOf('// Flatten a stored profile');
assert.notEqual(activeHelperStart, -1, 'Profiles does not define running profile detection');
const activeSandbox = {
  tasks: [
    { id: 'running', profileId: 'profile-running' },
    { id: 'stopped', profileId: 'profile-stopped' },
    { id: 'saved', profileId: 'profile-saved' },
  ],
  statuses: {
    running: { running: true },
    stopped: { running: false },
  },
};
vm.runInNewContext(
  `${profiles.slice(activeHelperStart, activeHelperEnd)}\nresult = activeTaskProfileIds(tasks, statuses);`,
  activeSandbox,
);
assert.deepEqual(JSON.parse(JSON.stringify(activeSandbox.result)), ['profile-running'],
  'IN USE does not exclusively reflect tasks with a live running status');

console.log('Nested profile groups and row workspace smoke test passed');
