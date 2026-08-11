#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const csstree = require('../frontend/node_modules/css-tree');
const { JSDOM } = require('../frontend/node_modules/jsdom');

const root = path.resolve(__dirname, '..');
const extension = path.join(root, 'chrome-extension', 'harvester');
const read = relative => fs.readFileSync(path.join(extension, relative), 'utf8');

const html = read('index.html');
const css = read('index.css');
const background = read('src/background.js');
const manifest = JSON.parse(read('manifest.json'));
const dom = new JSDOM(html);
const { document } = dom.window;

assert.equal(document.doctype && document.doctype.name, 'html');
assert.equal(document.documentElement.lang, 'en');
assert.ok(document.querySelector('meta[charset]'));
assert.ok(document.querySelector('meta[name="viewport"]'));
assert.equal(document.querySelector('title').textContent, 'Zyn Harvester');
assert.doesNotMatch(html, /https?:\/\//i, 'extension UI must not depend on remote styles, fonts, or scripts');

const coupledIds = [
  'enableProxyToggle', 'proxyListDrop', 'proxyInput', 'addListBtn', 'deleteListBtn',
  'importProxiesBtn', 'harvestToggleBtn', 'cookiesPerTaskValue', 'cookieExpiryValue',
  'scheduleStartToggle', 'scheduleEndToggle', 'scheduleStartGroup', 'scheduleEndGroup',
  'scheduleStartPicker', 'scheduleEndPicker', 'scheduleStartHour', 'scheduleStartMinute',
  'scheduleStartAmPm', 'scheduleEndHour', 'scheduleEndMinute', 'scheduleEndAmPm',
  'scheduleStartLabel', 'scheduleEndLabel', 'loginCookieCount', 'atcCookieCount',
  'botConnectionBadge', 'botStatusLabel', 'botConnectionState',
];
for (const id of coupledIds) {
  assert.equal(document.querySelectorAll(`#${id}`).length, 1, `expected exactly one #${id}`);
}

const harvestButton = document.getElementById('harvestToggleBtn');
assert.ok(harvestButton.querySelector('.actionIcon'));
assert.ok(harvestButton.querySelector('.actionButtonText'));
assert.equal(harvestButton.getAttribute('type'), 'button');

for (const key of ['cookiesPerTask', 'cookieExpiry']) {
  const counter = document.querySelector(`.counterInput[data-counter-key="${key}"]`);
  assert.ok(counter, `missing ${key} counter`);
  assert.ok(counter.querySelector('.minus-plus[data-counter-action="decrement"]'));
  assert.ok(counter.querySelector('.minus-plus[data-counter-action="increment"]'));
}

for (const id of ['scheduleStartToggle', 'scheduleEndToggle', 'enableProxyToggle']) {
  assert.ok(document.getElementById(id).getAttribute('aria-label'), `#${id} needs an accessible name`);
}
const routeToggle = document.getElementById('enableProxyToggle');
assert.equal(routeToggle.getAttribute('type'), 'checkbox');
assert.equal(routeToggle.getAttribute('role'), 'switch');
assert.match(routeToggle.getAttribute('aria-label'), /proxy list instead of local ip/i);
assert.equal(document.querySelector('.routeModeOption--local').textContent.trim(), 'Local IP');
assert.equal(document.querySelector('.routeModeOption--proxy').textContent.trim(), 'Proxy list');
assert.match(document.querySelector('.routeNoticeCopy--local').textContent, /Local IP selected[\s\S]*direct connection/);
assert.match(document.querySelector('.routeNoticeCopy--proxy').textContent,
  /Proxy list selected[\s\S]*fall back to Local IP/);
assert.equal(document.querySelector('.routeNotice').getAttribute('aria-live'), 'polite');
for (const button of document.querySelectorAll('button')) {
  assert.equal(button.getAttribute('type'), 'button', 'extension buttons must not default to form submission');
}
for (const image of document.querySelectorAll('img')) {
  assert.notEqual(image.getAttribute('alt'), null, `image ${image.getAttribute('src')} is missing alt text`);
}

for (const node of document.querySelectorAll('link[href], script[src], img[src]')) {
  const reference = node.getAttribute('href') || node.getAttribute('src');
  assert.ok(!/^(?:https?:)?\/\//i.test(reference), `remote UI asset: ${reference}`);
  assert.ok(fs.existsSync(path.join(extension, reference)), `missing UI asset: ${reference}`);
}

assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.action.default_title, 'Zyn Harvester');
assert.ok(fs.existsSync(path.join(extension, manifest.background.service_worker)));
for (const icon of Object.values(manifest.icons)) assert.ok(fs.existsSync(path.join(extension, icon)));
for (const rules of manifest.declarative_net_request.rule_resources) {
  assert.ok(fs.existsSync(path.join(extension, rules.path)));
}

assert.doesNotThrow(() => csstree.parse(css), 'extension CSS must parse');
assert.match(css, /--accent:\s*#e11d48/i);
assert.match(css, /linear-gradient\(135deg,\s*#be123c,\s*#e11d48\s+56%,\s*#f97316\)/i);
assert.match(css, /\.scheduleGroup\.is-active/);
assert.match(css, /\.actionButton\.is-harvesting/);
assert.match(css, /\.status\.is-disconnected/);
assert.match(css, /#enableProxyToggle:checked/);
assert.match(css, /\.routeModeOption--local/);
assert.match(css, /\.routeModeOption--proxy/);
assert.match(css, /\.routeNoticeCopy--local/);
assert.match(css, /\.routeNoticeCopy--proxy/);
assert.match(css, /max-width:\s*790px/);
assert.match(css, /max-height:\s*570px/);
assert.match(background, /It=0x316,wt=0x23a/,
  'background popup dimensions must remain 790 by 570');

const visualSources = [html, css];
for (const file of fs.readdirSync(path.join(extension, 'assets')).filter(name => name.endsWith('.svg'))) {
  const source = read(path.join('assets', file));
  visualSources.push(source);
  assert.match(source, /<svg\b/);
}
const visualSource = visualSources.join('\n');
assert.doesNotMatch(visualSource, /#5081FE|rgba\(80\s*,\s*129\s*,\s*254/i,
  'legacy blue styling remains in the extension UI');
assert.doesNotMatch(visualSource, /#01020A/i,
  'legacy navy background remains in the extension UI');

console.log(JSON.stringify({
  ok: true,
  viewport: '790x570',
  coupledIds: coupledIds.length,
  localAssets: document.querySelectorAll('link[href], script[src], img[src]').length,
  zynNightTheme: true,
}, null, 2));
