#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const { execFileSync } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

const project = path.join(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'zyn-checkout-webhook-'));
const reporter = path.join(temp, 'checkout-reporter.js');
const pbandai = path.join(temp, 'pbandai-buyer.cjs');
const example = 'https://discord.com/api/webhooks/123456789/example-token';

fs.copyFileSync(path.join(project, 'runtime-app', 'public', 'helpers', 'checkout-reporter.js'), reporter);
fs.copyFileSync(path.join(project, 'bot-runtime', 'pbandai-buyer.cjs'), pbandai);
execFileSync(process.execPath, [path.join(__dirname, 'patch-zyn-checkout-webhook.cjs'), reporter, pbandai], {
  env: { ...process.env, ZYN_GLOBAL_CHECKOUT_WEBHOOK: example },
  stdio: 'inherit',
});

for (const file of [reporter, pbandai]) {
  const source = fs.readFileSync(file, 'utf8');
  const matches = source.match(/https:\/\/discord\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/g) || [];
  assert.deepEqual(matches, [example]);
}
const reporterSource = fs.readFileSync(reporter, 'utf8');
const pbandaiSource = fs.readFileSync(pbandai, 'utf8');
assert.match(reporterSource, /username: 'Zyn'/);
assert.match(reporterSource, /avatar_url: 'https:\/\/zynbot\.app\/zyn-icon\.png'/);
assert.match(reporterSource, /footer: \{ text: 'Zyn', icon_url: 'https:\/\/zynbot\.app\/zyn-icon\.png' \}/);
assert.match(reporterSource, /if \(!ok\) return;[\s\S]*await postJson\(GLOBAL_WEBHOOK/,
  'failed checkout events can still reach the global collector');
assert.match(pbandaiSource, /\[t\.webhook,\.\.\.\(n==="confirmed"\?\[we\]:\[\]\)\]/,
  'P-Bandai failed outcomes can still reach the global collector');
assert.doesNotMatch(pbandaiSource, /await ye\(\[t\.webhook,we\],be\(t,e,a,s\[n\]\|\|n\)/,
  'P-Bandai still sends every final outcome to its global collector');

async function verifyCollectorPolicy() {
  const requests = [];
  const originalRequest = https.request;
  https.request = (options, callback) => {
    let body = '';
    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.destroy = () => {};
    request.write = chunk => { body += String(chunk); };
    request.end = () => {
      requests.push({ options, body: JSON.parse(body) });
      const response = new EventEmitter();
      response.statusCode = 204;
      response.resume = () => {};
      callback(response);
      process.nextTick(() => response.emit('end'));
    };
    return request;
  };

  try {
    delete require.cache[require.resolve(reporter)];
    const patchedReporter = require(reporter);
    await patchedReporter.report({ site: 'target', status: 'failed', product: 'Sold-out cart' });
    assert.equal(requests.length, 0, 'failed checkout reached the global Discord collector');
    await patchedReporter.report({ site: 'target', status: 'success', product: 'Confirmed order' });
    assert.equal(requests.length, 1, 'confirmed checkout did not reach the global Discord collector');
    assert.equal(requests[0].body.username, 'Zyn');
  } finally {
    https.request = originalRequest;
  }
}

verifyCollectorPolicy()
  .then(() => console.log('Global success webhook is injected without entering source control, and failed events are suppressed.'))
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
