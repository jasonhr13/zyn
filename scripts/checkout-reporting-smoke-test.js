#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const { installCheckoutReporting, signedInEmail } = require('../launcher/checkout-reporting');

let status = { ok: false, email: 'stale@example.com' };
let reporterContext = {};
const configured = [];
const reports = [];
const pbandaiStarts = [];
const reporter = {
  configure(next) {
    reporterContext = { ...reporterContext, ...next };
    configured.push({ ...reporterContext });
  },
  report(checkout) {
    reports.push({ checkout, context: { ...reporterContext } });
    return 'reported';
  },
};
const taskHandler = {
  startPbandai(options, window) {
    pbandaiStarts.push({ options, window });
    return 'started';
  },
};

assert.equal(signedInEmail(() => status), '');
installCheckoutReporting({ reporter, taskHandler, getLicenseStatus: () => status });
assert.equal(configured.at(-1).discord, '');

status = { ok: true, email: ' BUYER@EXAMPLE.COM ' };
assert.equal(reporter.report({ site: 'target' }), 'reported');
assert.equal(reports.at(-1).context.discord, 'buyer@example.com');
assert.equal(reports.at(-1).context.discordId, '');
assert.equal(reports.at(-1).context.key, '');
assert.equal(reports.at(-1).context.token, '');

reporter.configure({ discord: 'spoofed-name', discordId: '123', key: 'retired-key', token: 'retired-token' });
assert.equal(configured.at(-1).discord, 'buyer@example.com');
assert.equal(configured.at(-1).discordId, '');
assert.equal(configured.at(-1).key, '');
assert.equal(configured.at(-1).token, '');

status = { ok: true, email: 'second@example.com' };
assert.equal(taskHandler.startPbandai({ buyerDiscord: 'spoofed-name', dashboardKey: 'retired-key' }, 'window'), 'started');
assert.equal(pbandaiStarts.at(-1).options.buyerDiscord, 'second@example.com');
assert.equal(pbandaiStarts.at(-1).options.dashboardKey, '');

status = { ok: false, email: 'second@example.com' };
reporter.report({ site: 'walmart' });
assert.equal(reports.at(-1).context.discord, '');

console.log(JSON.stringify({
  ok: true,
  centralReporterUsesSignedInEmail: true,
  pbandaiUsesSignedInEmail: true,
  accountSwitchAppliedWithoutRestart: true,
  signedOutIdentityCleared: true,
}, null, 2));
