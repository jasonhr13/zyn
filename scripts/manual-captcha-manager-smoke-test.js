#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const contract = require('../launcher/native-engine-contract');
const { ManualCaptchaManager, parseProxy, buildCaptchaHtml } = require('../launcher/manual-captcha-manager').__test;

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

class FakeProtocol {
  constructor() { this.handlers = new Map(); this.unhandled = []; }
  async handle(scheme, handler) { this.handlers.set(scheme, handler); }
  async unhandle(scheme) { this.handlers.delete(scheme); this.unhandled.push(scheme); }
}

class FakeSession {
  constructor() {
    this.protocol = new FakeProtocol();
    this.proxy = null;
    this.savedCookies = [];
    this.cleared = false;
    this.cookies = { set: async cookie => { this.savedCookies.push(cookie); } };
  }
  async setProxy(config) { this.proxy = config; }
  async clearStorageData() { this.cleared = true; }
}

let nextWebContentsId = 10;
class FakeWebContents extends EventEmitter {
  constructor() {
    super();
    this.id = nextWebContentsId++;
    this.session = new FakeSession();
    this.token = '';
    this.userAgent = '';
    this.reloads = 0;
  }
  setUserAgent(value) { this.userAgent = value; }
  setWindowOpenHandler(handler) { this.windowHandler = handler; }
  async executeJavaScript() { return { token: this.token, error17: false }; }
  reloadIgnoringCache() { this.reloads += 1; }
}

class FakeBrowserWindow extends EventEmitter {
  static windows = [];
  static getFocusedWindow() { return null; }
  constructor(options) {
    super();
    this.options = options;
    this.webContents = new FakeWebContents();
    this.destroyed = false;
    this.visible = false;
    FakeBrowserWindow.windows.push(this);
  }
  async loadURL(url) { this.loadedUrl = url; this.emit('ready-to-show'); }
  show() { this.visible = true; }
  focus() { this.focused = true; }
  isDestroyed() { return this.destroyed; }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('closed');
  }
}

function fakeElectron() {
  const app = new EventEmitter();
  app.isPackaged = true;
  return {
    app,
    BrowserWindow: FakeBrowserWindow,
    net: { fetch: async request => ({ forwarded: request.url }) },
  };
}

function pcRegistry() {
  const registry = new contract.TaskSiteRegistry();
  registry.register('pc-1', contract.SITES.POKEMON_CENTER_US);
  registry.register('pc-2', contract.SITES.POKEMON_CENTER_US);
  registry.register('target-1', contract.SITES.TARGET);
  return registry;
}

function request(taskId = 'pc-1', extra = {}) {
  return {
    type: 'solve-captcha',
    messages: [{
      taskId,
      groupId: 'pc-group',
      siteKey: 'dd6e16a7-972e-47d2-93d0-96642fb6d8de',
      siteUrl: 'https://www.pokemoncenter.com/',
      hcapData: '',
      proxy: '',
      cookies: [],
      headers: [],
      captchaType: 'hcaptcha-PokemonCenter',
      ...extra,
    }],
  };
}

(async () => {
  assert.deepEqual(parseProxy('http://user%40mail:pass%3Aword@proxy.example:8080'), {
    rules: 'http://proxy.example:8080',
    username: 'user@mail',
    password: 'pass:word',
  });
  assert.equal(parseProxy(''), null);
  assert.throws(() => parseProxy('socks5://proxy.example:1080'), /HTTP proxy/);

  const escaped = buildCaptchaHtml({
    siteKey: '</script><script>bad()</script>',
    hcapData: '<payload>',
  });
  assert.doesNotMatch(escaped, /<script>bad\(\)<\/script>/);
  assert.match(escaped, /hcaptcha\.render/);
  assert.match(escaped, /hcaptcha\.execute/);
  assert.match(escaped, /window\.__zynCaptchaToken/);
  assert.match(escaped, /AutoSolve/);
  assert.doesNotMatch(buildCaptchaHtml({
    siteKey: 'key',
    hcapData: '',
    autosolve: false,
  }), /try AutoSolve first/);

  FakeBrowserWindow.windows = [];
  const electron = fakeElectron();
  const solves = [];
  const clicks = [];
  const autosolver = {
    start() {},
    async solve(challenge) {
      solves.push(challenge);
      return { solvable: true, coords: [[0, 1], [1, 0]] };
    },
  };
  const manager = new ManualCaptchaManager({
    electron, pollIntervalMs: 5, logger: { warn() {} }, autosolver,
  });
  const originalMaybe = manager.maybeAutosolve.bind(manager);
  manager.scrapeChallenge = async () => (solves.length ? null : {
    prompt: 'Click the buses',
    exampleImages: [],
    taskImages: [
      { url: 'https://imgs.hcaptcha.com/a.jpg', row: 0, col: 0 },
      { url: 'https://imgs.hcaptcha.com/b.jpg', row: 0, col: 1 },
      { url: 'https://imgs.hcaptcha.com/c.jpg', row: 1, col: 0 },
    ],
    cols: 3,
  });
  manager.clickTiles = async (_webContents, coords, cols) => {
    clicks.push({ coords, cols });
    return true;
  };
  void originalMaybe;
  const sent = [];
  const options = {
    registry: pcRegistry(),
    send: envelope => { sent.push(envelope); return true; },
    isActive: () => true,
  };
  await manager.handleEnvelope(request('pc-1', {
    proxy: 'http://user:pass@proxy.example:8080',
    cookies: ['incap=value; Path=/'],
    headers: ['User-Agent: Zyn Test Browser'],
  }), options);
  assert.equal(FakeBrowserWindow.windows.length, 1);
  const first = FakeBrowserWindow.windows[0];
  assert.equal(first.options.webPreferences.nodeIntegration, false);
  assert.equal(first.options.webPreferences.contextIsolation, true);
  assert.equal(first.options.webPreferences.sandbox, true);
  assert.deepEqual(first.webContents.session.proxy, {
    mode: 'fixed_servers', proxyRules: 'http://proxy.example:8080',
  });
  assert.equal(first.webContents.session.savedCookies[0].name, 'incap');
  assert.equal(first.webContents.userAgent, 'Zyn Test Browser');
  assert.equal(first.loadedUrl, 'https://www.pokemoncenter.com/');

  let prevented = false;
  let credentials = null;
  electron.app.emit('login', { preventDefault() { prevented = true; } }, first.webContents, {},
    { isProxy: true }, (username, password) => { credentials = { username, password }; });
  assert.equal(prevented, true);
  assert.deepEqual(credentials, { username: 'user', password: 'pass' });

  const handler = first.webContents.session.protocol.handlers.get('https');
  const document = await handler({ url: 'https://www.pokemoncenter.com/', method: 'GET' });
  assert.equal(document.status, 200);
  assert.match(await document.text(), /Pokémon Center verification/);
  const asset = await handler({ url: 'https://newassets.hcaptcha.com/captcha.js', method: 'GET' });
  assert.equal(asset.forwarded, 'https://newassets.hcaptcha.com/captcha.js');

  // A repeat from the same blocked Go task focuses its existing solver instead of opening another.
  await manager.handleEnvelope(request('pc-1'), options);
  assert.equal(FakeBrowserWindow.windows.length, 1);
  assert.equal(first.focused, true);

  await wait(25);
  assert.equal(solves.length, 1);
  assert.equal(solves[0].prompt, 'Click the buses');
  assert.deepEqual(clicks[0], { coords: [[0, 1], [1, 0]], cols: 3 });

  first.webContents.token = 'manual-token';
  await wait(25);
  assert.equal(manager.pendingCount(), 0);

  const disabledSolves = [];
  const disabled = new ManualCaptchaManager({
    electron, pollIntervalMs: 5, logger: { warn() {} },
    autosolver: { start() {}, async solve(challenge) { disabledSolves.push(challenge); return { solvable: true, coords: [[0, 0]] }; } },
  });
  disabled.scrapeChallenge = async () => ({
    prompt: 'Click the buses',
    exampleImages: [],
    taskImages: [{ url: 'https://imgs.hcaptcha.com/a.jpg', row: 0, col: 0 }],
    cols: 3,
  });
  await disabled.handleEnvelope(request('pc-1'), {
    ...options,
    autosolveEnabled: () => false,
  });
  await wait(25);
  assert.equal(disabledSolves.length, 0);
  await disabled.cancelPending();
  assert.equal(first.destroyed, true);
  assert.deepEqual(sent, [{
    type: 'received-token',
    messages: [{ taskId: 'pc-1', token: 'manual-token', site: 'Pokemon Center US' }],
  }]);
  assert.equal(first.webContents.session.cleared, true);

  // Task stop and connection teardown close the window without returning a late token.
  await manager.handleEnvelope(request('pc-2'), options);
  assert.equal(manager.pendingCount(), 1);
  await manager.cancelTask('pc-2');
  assert.equal(manager.pendingCount(), 0);
  assert.equal(sent.length, 1);

  // The task registry, captcha type, and URL allowlist all reject cross-site renderer requests.
  await manager.handleEnvelope(request('target-1'), options);
  await manager.handleEnvelope(request('pc-1', { siteUrl: 'https://example.com/' }), options);
  await manager.handleEnvelope(request('pc-1', { captchaType: 'recaptcha' }), options);
  assert.equal(FakeBrowserWindow.windows.length, 3);
  assert.equal(manager.pendingCount(), 0);

  console.log(JSON.stringify({
    ok: true,
    pokemonCenterOnly: true,
    autosolveThenManual: true,
    isolatedSession: true,
    proxyAuth: true,
    tokenCorrelation: true,
    duplicateGuard: true,
    lifecycleCancellation: true,
  }, null, 2));
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
