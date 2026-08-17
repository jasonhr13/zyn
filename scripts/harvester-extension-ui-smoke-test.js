#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const csstree = require('../frontend/node_modules/css-tree');
const { JSDOM } = require('../frontend/node_modules/jsdom');

const root = path.resolve(__dirname, '..');
const extension = path.join(root, 'chrome-extension', 'harvester');
const read = relative => fs.readFileSync(path.join(extension, relative), 'utf8');

const html = read('index.html');
const css = read('index.css');
const background = read('src/background.js');
const clientIdentity = read('client-identity.js');
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

assert.equal(document.getElementById('cookiesPerTaskValue').hidden, true,
  'legacy Cookies/Task script sink must not be visible');
assert.equal(document.querySelector('[data-counter-key="cookiesPerTask"]'), null,
  'extension still exposes its redundant Cookies/Task control');
assert.doesNotMatch(document.body.textContent, /Cookies\s*\/\s*Task/i,
  'extension still labels a Cookies/Task setting');

for (const key of ['cookieExpiry']) {
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
assert.deepEqual([...document.querySelectorAll('script[src]')].map(node => node.getAttribute('src')),
  ['client-identity.js', 'index.js'], 'client identity must load before the popup bridge client');

assert.equal(manifest.manifest_version, 3);
const versionParts = String(manifest.version || '').split('.');
assert.ok(versionParts.length >= 1 && versionParts.length <= 4,
  'extension version must contain one to four components');
assert.ok(versionParts.some(part => part !== '0') && versionParts.every(part => (
  /^(?:0|[1-9]\d*)$/.test(part) && Number(part) <= 65535
)), 'extension version must follow Chrome numeric version rules');
assert.equal(manifest.action.default_title, 'Zyn Harvester');
assert.ok(fs.existsSync(path.join(extension, manifest.background.service_worker)));
assert.match(background, /import '\.\.\/client-identity\.js';\s*$/,
  'service worker must load the shared client identity module');
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

const atcPageSessionSource = read('src/atc-page-session.js');
assert.match(background, /from'\.\/atc-page-session\.js'/,
  'service worker must load the ATC page-session policy');
assert.match(background, /noteAtcPageCapture\(atcPageSession\)/,
  'a good ATC capture must count against the current page life');
assert.match(background, /if\(ne\(\)&&atcPageSessionExhausted\(atcPageSession\)\)/,
  'an exhausted ATC page life must reset before the next click');
assert.match(background, /atcPageSession=createAtcPageSession\(\)/,
  'a quality reset must start a fresh ATC page life');
assert.doesNotMatch(background, /if\(ne\(\)\)try\{await ae\(d\),await b\(0x258,0x3e8\);\}/,
  'successful ATC captures must not reload the product page every time');
assert.match(background, /else\{try\{await et\(\);\}catch\(_0x50bd82\)\{console\['warn'\]\('Failed\\x20to\\x20rotate\\x20proxy\\x20after\\x20harvest'/,
  'login captures must still rotate the proxy after each save');
assert.match(background, /no\\x20headers\\x20after\\x20add-to-cart\\x20click[\s\S]{0,220}await de\(!0x1\)/,
  'a dead Shape sensor must still trigger a full quality reset');

const atcPageSession = {};
new Function('exports', atcPageSessionSource.replace(/\bexport\s+/g, '')
  + '\nObject.assign(exports,{ATC_PAGE_COOKIE_LIMIT,ATC_PAGE_LIFE_MS,createAtcPageSession,atcPageSessionExhausted,noteAtcPageCapture});')(atcPageSession);
assert.equal(atcPageSession.ATC_PAGE_COOKIE_LIMIT, 6);
assert.equal(atcPageSession.ATC_PAGE_LIFE_MS, 15_000);
assert.equal(atcPageSession.atcPageSessionExhausted(null), false);
assert.equal(atcPageSession.atcPageSessionExhausted({ count: 5, startedAt: 1_000 }, 1_000), false);
assert.equal(atcPageSession.atcPageSessionExhausted({ count: 6, startedAt: 1_000 }, 1_000), true);
assert.equal(atcPageSession.atcPageSessionExhausted({ count: 1, startedAt: 1_000 }, 16_000), true);
let life = atcPageSession.createAtcPageSession(1_000);
for (let n = 1; n <= 5; n += 1) {
  const noted = atcPageSession.noteAtcPageCapture(life, 1_000 + n);
  life = noted.session;
  assert.equal(noted.exhausted, false, `cookie ${n} must stay on the warm page`);
}
assert.equal(atcPageSession.noteAtcPageCapture(life, 1_006).exhausted, true,
  'the sixth ATC cookie on a page must exhaust the session');

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

async function runIdentityContext({
  storage, userAgent, brave = false, locks = undefined, storageGate = null,
  waitForIdentity = true,
}) {
  const sent = [];
  function TestWebSocket(url) {
    this.url = url;
    this.readyState = TestWebSocket.OPEN;
  }
  TestWebSocket.OPEN = 1;
  TestWebSocket.CLOSED = 3;
  TestWebSocket.prototype.send = function send(data) { sent.push({ url: this.url, data }); };
  TestWebSocket.prototype.close = function close() { this.readyState = TestWebSocket.CLOSED; };
  const local = {
    get(keys, callback) {
      const read = () => {
        const result = {};
        for (const key of keys) if (Object.prototype.hasOwnProperty.call(storage, key)) result[key] = storage[key];
        queueMicrotask(() => callback(result));
      };
      if (storageGate) storageGate.then(read);
      else read();
    },
    set(values, callback) {
      Object.assign(storage, values);
      queueMicrotask(() => callback && callback());
    },
  };
  const context = vm.createContext({
    chrome: { storage: { local } },
    console,
    crypto: webcrypto,
    navigator: {
      userAgent,
      userAgentData: { brands: [] },
      ...(locks ? { locks } : {}),
      ...(brave ? { brave: { isBrave: async () => true } } : {}),
    },
    queueMicrotask,
    WebSocket: TestWebSocket,
  });
  vm.runInContext(clientIdentity, context, { filename: 'client-identity.js' });
  const identityPromise = context.zynHarvesterClientIdentity();
  if (!waitForIdentity) return { context, identityPromise, sent };
  const identity = await identityPromise;
  return { context, identity, identityPromise, sent };
}

async function verifyClientIdentity() {
  const storage = {};
  const brave = await runIdentityContext({
    storage,
    brave: true,
    userAgent: 'Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36',
  });
  assert.match(brave.identity.clientId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(storage.zynHarvesterClientId, brave.identity.clientId);
  assert.equal(brave.identity.browser, 'Brave');

  const bridge = new brave.context.WebSocket('ws://127.0.0.1:4312/ws');
  bridge.send(JSON.stringify({ action: 'status', clientId: 'spoofed', browser: 'Spoofed' }));
  bridge.send(JSON.stringify({ action: 'save', type: 'atc' }));
  const unrelated = new brave.context.WebSocket('ws://127.0.0.1:9999/ws');
  unrelated.send(JSON.stringify({ action: 'status' }));
  await new Promise(resolve => setImmediate(resolve));

  const records = brave.sent.map(item => ({ ...item, payload: JSON.parse(item.data) }));
  const status = records.find(item => item.url.endsWith(':4312/ws') && item.payload.action === 'status').payload;
  const save = records.find(item => item.url.endsWith(':4312/ws') && item.payload.action === 'save').payload;
  const untouched = records.find(item => item.url.endsWith(':9999/ws')).payload;
  assert.equal(status.clientId, brave.identity.clientId,
    'status payload must carry the stored client ID');
  assert.equal(status.browser, brave.identity.browser,
    'status payload must carry the detected browser');
  assert.equal(save.clientId, brave.identity.clientId,
    'save payload must carry the stored client ID');
  assert.equal(save.browser, brave.identity.browser,
    'save payload must carry the detected browser');
  assert.equal(untouched.clientId, undefined, 'non-bridge WebSockets must not be modified');

  const chrome = await runIdentityContext({
    storage,
    userAgent: 'Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36',
  });
  assert.equal(chrome.identity.clientId, brave.identity.clientId,
    'a new extension context must reuse the stored installation ID');
  assert.equal(chrome.identity.browser, 'Chrome');

  let lockTail = Promise.resolve();
  const locks = {
    request(_name, callback) {
      const result = lockTail.then(callback);
      lockTail = result.catch(() => {});
      return result;
    },
  };
  const concurrentStorage = {};
  const [popup, serviceWorker] = await Promise.all([
    runIdentityContext({
      storage: concurrentStorage, locks, waitForIdentity: false,
      userAgent: 'Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36',
    }),
    runIdentityContext({
      storage: concurrentStorage, locks, waitForIdentity: false,
      userAgent: 'Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36',
    }),
  ]);
  const [popupIdentity, serviceWorkerIdentity] = await Promise.all([
    popup.identityPromise, serviceWorker.identityPromise,
  ]);
  assert.equal(popupIdentity.clientId, serviceWorkerIdentity.clientId,
    'concurrent popup/service-worker initialization must converge on one client ID');

  const noLockStorage = {};
  const [noLockPopup, noLockWorker] = await Promise.all([
    runIdentityContext({
      storage: noLockStorage, waitForIdentity: false,
      userAgent: 'Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36',
    }),
    runIdentityContext({
      storage: noLockStorage, waitForIdentity: false,
      userAgent: 'Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36',
    }),
  ]);
  const [noLockPopupIdentity, noLockWorkerIdentity] = await Promise.all([
    noLockPopup.identityPromise, noLockWorker.identityPromise,
  ]);
  assert.equal(noLockPopupIdentity.clientId, noLockWorkerIdentity.clientId,
    'the no-Web-Locks fallback must re-read the winning stored client ID');

  let releaseStorage;
  const storageGate = new Promise(resolve => { releaseStorage = resolve; });
  const delayed = await runIdentityContext({
    storage: {}, storageGate, waitForIdentity: false,
    userAgent: 'Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36',
  });
  const delayedSocket = new delayed.context.WebSocket('ws://127.0.0.1:4312/ws');
  delayedSocket.send(JSON.stringify({ action: 'status' }));
  assert.equal(delayed.sent.length, 0, 'first-launch bridge send must wait for client identity');
  releaseStorage();
  const delayedIdentity = await delayed.identityPromise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(delayed.sent.length, 1);
  assert.equal(JSON.parse(delayed.sent[0].data).clientId, delayedIdentity.clientId);

  let releaseClosedStorage;
  const closedStorageGate = new Promise(resolve => { releaseClosedStorage = resolve; });
  const closed = await runIdentityContext({
    storage: {}, storageGate: closedStorageGate, waitForIdentity: false,
    userAgent: 'Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36',
  });
  const closedSocket = new closed.context.WebSocket('ws://127.0.0.1:4312/ws');
  closedSocket.send(JSON.stringify({ action: 'status' }));
  closedSocket.close();
  releaseClosedStorage();
  await closed.identityPromise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed.sent.length, 0,
    'identity resolution must not send or retry on a WebSocket that already closed');
}

verifyClientIdentity().then(() => {
  console.log(JSON.stringify({
    ok: true,
    viewport: '790x570',
    coupledIds: coupledIds.length,
    localAssets: document.querySelectorAll('link[href], script[src], img[src]').length,
    stableClientIdentity: true,
    zynNightTheme: true,
    atcPageCookieLimit: 6,
    atcPageLifeMs: 15000,
  }, null, 2));
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
