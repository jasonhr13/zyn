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
const privateExample = 'https://discord.com/api/webhooks/123456789/private-token';
const publicExample = 'https://discord.com/api/webhooks/987654321/public-token';

fs.copyFileSync(path.join(project, 'runtime-app', 'public', 'helpers', 'checkout-reporter.js'), reporter);
fs.copyFileSync(path.join(project, 'bot-runtime', 'pbandai-buyer.cjs'), pbandai);
execFileSync(process.execPath, [path.join(__dirname, 'patch-zyn-checkout-webhook.cjs'), reporter, pbandai], {
  env: {
    ...process.env,
    ZYN_PRIVATE_CHECKOUT_WEBHOOK: privateExample,
    ZYN_PUBLIC_CHECKOUT_WEBHOOK: publicExample,
    ZYN_GLOBAL_CHECKOUT_WEBHOOK: publicExample,
  },
  stdio: 'inherit',
});

const reporterMatches = fs.readFileSync(reporter, 'utf8')
  .match(/https:\/\/discord\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/g) || [];
assert.deepEqual([...new Set(reporterMatches)].sort(), [privateExample, publicExample].sort());
const pbandaiMatches = fs.readFileSync(pbandai, 'utf8')
  .match(/https:\/\/discord\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/g) || [];
assert.deepEqual(pbandaiMatches, [privateExample]);
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
    await patchedReporter.report({
      site: 'target', status: 'success', product: 'Confirmed order',
      price: 359.99, qty: 1, account: 'secret@example.com', order: '12345',
      source: 'chrome', image: 'https://example.test/box.png',
    });
    assert.equal(requests.length, 2, 'confirmed Target checkout must hit collector and public webhooks');
    const paths = requests.map(item => item.options.path);
    assert.equal(paths.filter(path => path.includes('/private-token')).length, 1);
    assert.equal(paths.filter(path => path.includes('/public-token')).length, 1);
    const privateBody = requests.find(item => item.options.path.includes('/private-token')).body;
    const publicBody = requests.find(item => item.options.path.includes('/public-token')).body;
    assert.equal(privateBody.username, 'Zyn');
    assert.equal(privateBody.embeds[0].fields.some(field => field.name === 'Buyer'), true);
    assert.equal(privateBody.embeds[0].fields.some(field => field.name === 'Account'), true);
    assert.equal(publicBody.username, 'Zyn');
    assert.equal(publicBody.embeds[0].title, 'Successful Checkout :tada:');
    assert.deepEqual(publicBody.embeds[0].fields.map(field => field.name), ['Product', 'Price', 'Size', 'Site']);
    assert.equal(publicBody.embeds[0].fields.some(field => /secret@|12345|chrome|Buyer|Account|Order/.test(JSON.stringify(field))), false);
    assert.equal(publicBody.embeds[0].thumbnail.url, 'https://example.test/box.png');
    requests.length = 0;
    await patchedReporter.report({ site: 'pbandai', status: 'success', product: 'Secret Lair' });
    assert.equal(requests.length, 1, 'non-Target/Pokémon successes must not reach the public webhook');
    assert.equal(requests[0].options.path.includes('/private-token'), true);
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
