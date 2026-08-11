#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { targetGroupStandbyTaskCount } = require('../launcher/target-cookie-standby');

assert.equal(targetGroupStandbyTaskCount(null), 0);
assert.equal(targetGroupStandbyTaskCount([]), 0);
assert.equal(targetGroupStandbyTaskCount([
  { site: 'target', tasks: [{ id: 'a' }, { id: 'b' }] },
  { site: 'pokemoncenter', tasks: Array.from({ length: 20 }, (_, index) => ({ id: `pc-${index}` })) },
  { tasks: [{ id: 'c' }, { id: 'd' }, { id: 'e' }] },
  { site: 'TARGET', tasks: [{ id: 'f' }] },
]), 3, 'standby demand must use the largest Target group, not sum mutually exclusive groups');

const bootstrap = fs.readFileSync(path.join(__dirname, '..', 'launcher', 'bootstrap.js'), 'utf8');
assert.match(bootstrap, /setTargetHarvestAuthorized\?\.\(authorized === true\)/,
  'launcher must gate Target harvesting on the replacement license authority');
assert.match(bootstrap, /onStatus: status => \{[\s\S]{0,180}setTargetHarvestAuthorization\(status && status\.ok === true\)/,
  'license status changes must update the reversible Target harvest gate');
assert.match(bootstrap, /onLock: \(\) => \{[\s\S]{0,120}setTargetHarvestAuthorization\(false\)/,
  'license revocation must pause Target harvesting before stopping tasks');
assert.match(bootstrap, /if \(!licenseAuthority\) setTargetHarvestAuthorization\(true\)/,
  'non-enforcing development builds must explicitly open the default-closed harvest gate');

console.log('Target standby cookie demand uses the largest saved Target group');
