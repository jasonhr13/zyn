#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const project = path.join(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'zyn-checkout-webhook-'));
const reporter = path.join(temp, 'checkout-reporter.js');
const pbandai = path.join(temp, 'pbandai-buyer.cjs');
const example = 'https://discord.com/api/webhooks/123456789/example-token';

fs.copyFileSync(path.join(project, 'extracted', 'asar', 'public', 'helpers', 'checkout-reporter.js'), reporter);
fs.copyFileSync(path.join(project, 'dist', 'Zyn-Runtime-Base.app', 'Contents', 'Resources', 'bot', 'pbandai-buyer.cjs'), pbandai);
execFileSync(process.execPath, [path.join(__dirname, 'patch-zyn-checkout-webhook.cjs'), reporter, pbandai], {
  env: { ...process.env, ZYN_GLOBAL_CHECKOUT_WEBHOOK: example },
  stdio: 'inherit',
});

for (const file of [reporter, pbandai]) {
  const source = fs.readFileSync(file, 'utf8');
  const matches = source.match(/https:\/\/discord\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/g) || [];
  assert.deepEqual(matches, [example]);
}
console.log('Global checkout webhook is injected into the central and P-Bandai reporters without entering source control.');
