#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractTargetAtcV2Tcin,
  generateTargetAtcV2Html,
  runTargetAtcV2Flow,
  TARGET_ATC_V2_ATC_SELECTOR,
  TARGET_ATC_V2_SHIPPING_SELECTOR,
  TARGET_ATC_V2_SOURCE,
  TARGET_ATC_V2_SSX_SELECTOR,
} from '../native-farmer/target-atc-v2.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const htmlFile = path.join(root, 'native-farmer', 'target-atc-v2.html');
const template = fs.readFileSync(htmlFile, 'utf8');
const sha256 = crypto.createHash('sha256').update(template).digest('hex');

assert.equal(sha256, '935aec9c1ca4139ee674f543422dc05018421e9fe17023c3d09e0824c6290339',
  'the recovered synthetic PDP must remain byte-for-byte intact');
assert.equal(extractTargetAtcV2Tcin('https://www.target.com/p/example/-/A-12345678'), '12345678');
assert.equal(extractTargetAtcV2Tcin('invalid'), '90188801');

const generated = generateTargetAtcV2Html('https://www.target.com/p/example/-/A-12345678');
assert.match(generated, /var TCIN = "12345678";/);
assert.match(generated, /addToCartButtonOrTextIdFor12345678/);
assert.doesNotMatch(generated, /90188801/);
assert.match(generated, /assets\.targetimg1\.com\/ssx\/ssx\.mod\.js\?async/);
assert.match(generated, /carts\.target\.com\/web_checkouts\/v1\/cart_items/);

const events = [];
let routePattern = null;
let routeHandler = null;
let fulfilled = null;
let removedHandler = null;
const page = {
  async route(pattern, handler) {
    events.push('pdp-hijack');
    routePattern = pattern;
    routeHandler = handler;
  },
  async unroute(pattern, handler) {
    events.push('clear-hijack');
    assert.equal(pattern, routePattern);
    removedHandler = handler;
  },
  async goto(url, options) {
    events.push('navigate');
    assert.equal(url, 'https://www.target.com/p/example/-/A-12345678');
    assert.deepEqual(options, { waitUntil: 'domcontentloaded', timeout: 2500 });
    assert.equal(routePattern.test(url), true);
    await routeHandler({
      request: () => ({
        method: () => 'GET',
        resourceType: () => 'document',
        isNavigationRequest: () => true,
      }),
      fulfill: async response => { fulfilled = response; events.push('serve-synthetic-pdp'); },
      continue: async () => { throw new Error('PDP document unexpectedly continued to Target'); },
    });
  },
  async waitForSelector(selector) {
    events.push(`wait:${selector}`);
    return {};
  },
  async click(selector) {
    events.push(`page-click:${selector}`);
  },
};
const human = {
  async click(selector) {
    events.push(`mouse:${selector}`);
    return true;
  },
};
const headers = { 'x-gyjwza5z-a': 'shape-a' };
const result = await runTargetAtcV2Flow({
  page,
  human,
  productLink: 'https://www.target.com/p/example/-/A-12345678',
  waitForHeaders() {
    events.push('wait-for-cart-headers');
    return Promise.resolve(headers);
  },
});

assert.equal(fulfilled.status, 200);
assert.equal(fulfilled.contentType, 'text/html; charset=utf-8');
assert.match(fulfilled.body, /var TCIN = "12345678";/);
assert.equal(removedHandler, routeHandler, 'the exact PDP interception handler must be cleared');
assert.deepEqual(result, { headers, source: TARGET_ATC_V2_SOURCE, tcin: '12345678' });
assert.ok(events.indexOf(`wait:${TARGET_ATC_V2_SSX_SELECTOR}`) > events.indexOf('navigate'));
assert.ok(events.indexOf(`mouse:${TARGET_ATC_V2_SHIPPING_SELECTOR}`)
  > events.indexOf(`wait:${TARGET_ATC_V2_SSX_SELECTOR}`));
assert.ok(events.indexOf('wait-for-cart-headers')
  > events.indexOf(`mouse:${TARGET_ATC_V2_SHIPPING_SELECTOR}`));
assert.ok(events.indexOf(`mouse:${TARGET_ATC_V2_ATC_SELECTOR}`)
  > events.indexOf('wait-for-cart-headers'));
assert.ok(events.indexOf('clear-hijack') > events.indexOf(`mouse:${TARGET_ATC_V2_ATC_SELECTOR}`));

const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const farmer = read('native-farmer/shape-farmer.mjs');
const taskGroups = read('frontend/src/components/pages/task-groups.js');
const configFragment = read('scripts/target-multi-harvester-config.fragment.js');
const producerFragment = read('scripts/target-multi-harvester-producers.fragment.js');
const build = read('scripts/build-zyn.sh');

assert.match(farmer, /argOf\('atcMode', 'v1'\)/, 'V1 must remain the CLI default');
assert.match(farmer, /runTargetAtcV2Flow\(/, 'the ATC worker must dispatch to the V2 flow');
assert.match(farmer, /source: type === 'atc'.*TARGET_ATC_V2_SOURCE/, 'V2 cookies need source metadata');
assert.match(taskGroups, /<option value="v2">ATC\+<\/option>\s*<\/select>\s*<\/div>/,
  'the harvester editor must expose only the ATC+ label');
assert.match(configFragment, /atcMode: raw && raw\.atcMode === 'v2' \? 'v2' : 'v1'/);
assert.match(producerFragment, /`--atcMode=\$\{config\.atcMode\}`/);
assert.match(build, /native-farmer\/"\*\.html/, 'the recovered PDP must be bundled beside the farmer');

console.log('Target ATC+ synthetic PDP, interaction order, mode plumbing, and metadata passed');
