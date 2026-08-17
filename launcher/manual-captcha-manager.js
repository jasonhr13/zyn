'use strict';

const fs = require('fs');
const path = require('path');
const contract = require('./native-engine-contract');

const POKEMON_CENTER_URL = 'https://www.pokemoncenter.com/';
const POKEMON_CENTER_ORIGIN = new URL(POKEMON_CENTER_URL).origin;
const POKEMON_CENTER_CAPTCHA = 'hcaptcha-PokemonCenter';
const DEFAULT_POLL_MS = 400;
const CAPTCHA_WINDOW_WIDTH = 530;
const CAPTCHA_WINDOW_HEIGHT = 660;
const CAPTCHA_WINDOW_OFFSET = 32;

function requiredText(value, label, maxLength) {
  const text = String(value == null ? '' : value).trim();
  if (!text) throw new Error(`${label} is required`);
  if (text.length > maxLength) throw new Error(`${label} is too long`);
  return text;
}

function scriptValue(value) {
  return JSON.stringify(String(value == null ? '' : value))
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

function normalizeSiteUrl(value) {
  const raw = requiredText(value, 'captcha site URL', 512);
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error('captcha site URL is invalid'); }
  if (parsed.protocol !== 'https:' || parsed.origin !== POKEMON_CENTER_ORIGIN || parsed.pathname !== '/') {
    throw new Error('manual captcha is restricted to Pokemon Center US');
  }
  return POKEMON_CENTER_URL;
}

function parseProxy(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return null;
  if (raw.length > 2048) throw new Error('captcha proxy is too long');
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error('captcha proxy is invalid'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || !parsed.port) {
    throw new Error('captcha proxy must be an HTTP proxy with a host and port');
  }
  const username = decodeURIComponent(parsed.username || '');
  const password = decodeURIComponent(parsed.password || '');
  return {
    rules: `${parsed.protocol}//${parsed.hostname}:${parsed.port}`,
    username,
    password,
  };
}

function parseCookie(value) {
  const first = String(value == null ? '' : value).split(';', 1)[0];
  const separator = first.indexOf('=');
  if (separator <= 0) return null;
  const name = first.slice(0, separator).trim();
  const cookieValue = first.slice(separator + 1).trim();
  if (!name || name.length > 256 || cookieValue.length > 8192) return null;
  return { name, value: cookieValue };
}

function userAgentFrom(headers) {
  for (const header of headers) {
    const line = String(header == null ? '' : header);
    const match = line.match(/^user-agent\s*:\s*(.+)$/i);
    if (match && match[1].trim().length <= 1024) return match[1].trim();
  }
  return '';
}

function normalizeSolve(message, registry) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw new Error('captcha request must be an object');
  }
  const taskId = requiredText(contract.taskIdOf(message), 'captcha task id', 256);
  const explicitSite = contract.canonicalSite(message.site || message.siteName, { required: false });
  const registeredSite = registry && registry.resolve({ taskId });
  if (explicitSite && explicitSite !== contract.SITES.POKEMON_CENTER_US) {
    throw new Error('manual captcha request has the wrong site');
  }
  if (registeredSite !== contract.SITES.POKEMON_CENTER_US) {
    throw new Error('manual captcha requires an active Pokemon Center US task');
  }
  const captchaType = requiredText(message.captchaType, 'captcha type', 128);
  if (captchaType !== POKEMON_CENTER_CAPTCHA) throw new Error(`unsupported captcha type: ${captchaType}`);
  const cookies = Array.isArray(message.cookies) ? message.cookies.slice(0, 100) : [];
  const headers = Array.isArray(message.headers) ? message.headers.slice(0, 100) : [];
  return {
    taskId,
    groupId: String(message.groupId || message.groupID || '').slice(0, 256),
    site: contract.SITES.POKEMON_CENTER_US,
    siteKey: requiredText(message.siteKey, 'captcha site key', 256),
    siteUrl: normalizeSiteUrl(message.siteUrl || message.siteURL),
    hcapData: String(message.hcapData == null ? '' : message.hcapData).slice(0, 32768),
    captchaType,
    proxy: parseProxy(message.proxy),
    cookies: cookies.map(parseCookie).filter(Boolean),
    userAgent: userAgentFrom(headers),
  };
}

function buildCaptchaHtml(solve) {
  const autosolve = solve && solve.autosolve !== false;
  const siteKey = scriptValue(solve.siteKey);
  const rqdata = scriptValue(solve.hcapData);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' https://hcaptcha.com https://*.hcaptcha.com; frame-src https://hcaptcha.com https://*.hcaptcha.com; connect-src https://hcaptcha.com https://*.hcaptcha.com; img-src data: blob: https://hcaptcha.com https://*.hcaptcha.com; style-src 'unsafe-inline' https://hcaptcha.com https://*.hcaptcha.com; font-src https://hcaptcha.com https://*.hcaptcha.com">
  <title>Zyn Manual Captcha</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    html, body { width: 100%; min-height: 100%; margin: 0; background: #090b18; color: #f5f7ff; }
    body { display: grid; place-items: center; padding: 28px; }
    main { width: min(100%, 460px); text-align: center; }
    .mark { width: 42px; height: 42px; margin: 0 auto 16px; border-radius: 13px; display: grid; place-items: center; background: linear-gradient(145deg, #783cff, #ad66ff); box-shadow: 0 12px 32px rgba(127, 68, 255, .28); font-weight: 800; font-size: 20px; }
    h1 { margin: 0; font-size: 19px; font-weight: 720; letter-spacing: -.02em; }
    p { margin: 8px 0 24px; color: #959bb2; font-size: 13px; line-height: 1.5; }
    #captcha-shell { min-height: 190px; display: grid; place-items: center; padding: 22px; border: 1px solid #22263a; border-radius: 16px; background: #101321; box-shadow: 0 18px 55px rgba(0, 0, 0, .28); }
    #status { margin-top: 16px; min-height: 18px; color: #8f96ac; font-size: 12px; }
    .pulse { display: inline-block; width: 7px; height: 7px; margin-right: 7px; border-radius: 50%; background: #9a5cff; box-shadow: 0 0 12px rgba(154, 92, 255, .8); animation: pulse 1.5s ease-in-out infinite; }
    @keyframes pulse { 50% { opacity: .35; transform: scale(.8); } }
  </style>
</head>
<body>
  <main>
    <div class="mark">Z</div>
    <h1>Pokémon Center verification</h1>
    <p>${autosolve
    ? 'Zyn will try AutoSolve once. If that misses, complete the next challenge below.'
    : 'Complete the challenge below. Zyn will return the token to your waiting task automatically.'}</p>
    <section id="captcha-shell"><div id="h-captcha"></div></section>
    <div id="status"><span class="pulse"></span><span id="status-text">Loading hCaptcha…</span></div>
  </main>
  <script>
    const siteKey = ${siteKey};
    const rqdata = ${rqdata};
    window.__zynCaptchaToken = '';
    window.__zynCaptchaWidget = null;
    function setStatus(text) { document.getElementById('status-text').textContent = text; }
    function solved(token) {
      if (!token) return;
      window.__zynCaptchaToken = String(token);
      setStatus('Solved — returning to Zyn…');
    }
    function expired() {
      window.__zynCaptchaToken = '';
      setStatus('Challenge expired — loading another…');
      try { hcaptcha.reset(window.__zynCaptchaWidget); hcaptcha.execute(window.__zynCaptchaWidget); } catch {}
    }
    function failed() { setStatus('Challenge error — please try again.'); }
    function onCaptchaLoad() {
      try {
        window.__zynCaptchaWidget = hcaptcha.render('h-captcha', {
          sitekey: siteKey,
          callback: solved,
          'error-callback': failed,
          'expired-callback': expired,
          'chalexpired-callback': expired,
        });
        if (rqdata) hcaptcha.setData({ rqdata });
        setStatus('Waiting for challenge…');
        hcaptcha.execute(window.__zynCaptchaWidget);
      } catch (error) {
        setStatus('Could not load the challenge. Close this window to retry.');
      }
    }
  </script>
  <script src="https://hcaptcha.com/1/api.js?onload=onCaptchaLoad&amp;render=explicit&amp;hl=en" async defer></script>
</body>
</html>`;
}

const SCRAPE_CHALLENGE = `(() => {
  const textOf = (el) => String(el && (el.innerText || el.textContent) || '').trim();
  const urlOf = (el) => {
    if (!el) return '';
    const src = String(el.currentSrc || el.src || '').trim();
    if (src && !src.startsWith('data:')) return src;
    const bg = String((el.style && el.style.backgroundImage) || '').trim()
      || (typeof getComputedStyle === 'function' ? String(getComputedStyle(el).backgroundImage || '') : '');
    const match = bg.match(/url\\(["']?(https?:[^"')]+)["']?\\)/i);
    return match ? match[1] : '';
  };
  const prompt = textOf(document.querySelector('.prompt-text, .challenge-prompt h2, .challenge-header .prompt-text, [class*="prompt-text"]'));
  const exampleImages = [...document.querySelectorAll('.challenge-example img, .challenge-example .image, .crumbs-wrapper img, .example img')]
    .map(urlOf).filter(Boolean);
  const tiles = [...document.querySelectorAll('.task-image, .task, [class*="task-image"]')];
  const count = tiles.length;
  const cols = count === 9 ? 3 : count === 16 ? 4 : Math.max(1, Math.round(Math.sqrt(count)) || 3);
  const taskImages = tiles.map((el, index) => ({
    url: urlOf(el.querySelector('img, .image, [class*="image"]') || el),
    row: Math.floor(index / cols),
    col: index % cols,
    index,
  })).filter(tile => tile.url);
  return { prompt, exampleImages, taskImages, cols, count };
})()`;

function clickTilesScript(coords, cols) {
  return `(() => {
    const coords = ${JSON.stringify(coords)};
    const cols = ${Number(cols) || 3};
    const tiles = [...document.querySelectorAll('.task-image, .task, [class*="task-image"]')];
    const wanted = new Set(coords.map(([row, col]) => Number(row) * cols + Number(col)));
    tiles.forEach((el, index) => { if (wanted.has(index)) el.click(); });
    const submit = document.querySelector('.button-submit, .submit-button, .challenge-footer button, button[class*="submit"]');
    if (submit) submit.click();
    return wanted.size;
  })()`;
}

function workAreaFor(electron, parent) {
  const screen = electron && electron.screen;
  if (!screen) return null;
  try {
    const bounds = parent && typeof parent.getBounds === 'function' ? parent.getBounds() : null;
    const display = (bounds && screen.getDisplayMatching)
      ? screen.getDisplayMatching(bounds)
      : screen.getPrimaryDisplay?.();
    const area = display && display.workArea;
    if (!area) return null;
    return {
      x: Number(area.x) || 0,
      y: Number(area.y) || 0,
      width: Number(area.width) || 0,
      height: Number(area.height) || 0,
    };
  } catch {
    return null;
  }
}

function captchaWindowBounds(electron, parent, stackIndex) {
  const width = CAPTCHA_WINDOW_WIDTH;
  const height = CAPTCHA_WINDOW_HEIGHT;
  const area = workAreaFor(electron, parent);
  const parentBounds = parent && typeof parent.getBounds === 'function' ? parent.getBounds() : null;
  const originX = parentBounds ? parentBounds.x + 56 : (area ? area.x + 72 : 80);
  const originY = parentBounds ? parentBounds.y + 48 : (area ? area.y + 56 : 60);
  let x = originX + (Number(stackIndex) || 0) * CAPTCHA_WINDOW_OFFSET;
  let y = originY + (Number(stackIndex) || 0) * CAPTCHA_WINDOW_OFFSET;
  if (area && area.width >= width && area.height >= height) {
    x = Math.min(Math.max(area.x, x), area.x + area.width - width);
    y = Math.min(Math.max(area.y, y), area.y + area.height - height);
  }
  return { x, y, width, height };
}

function loadAutosolver() {
  const candidates = [
    process.resourcesPath && path.join(process.resourcesPath, 'app', 'hcaptcha-autosolver.js'),
    path.join(__dirname, 'hcaptcha-autosolver.js'),
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) return require(file);
    } catch {}
  }
  return null;
}

function challengeKey(challenge) {
  if (!challenge || !challenge.prompt) return '';
  const tiles = (challenge.taskImages || []).map(tile => tile.url).join('|');
  return `${challenge.prompt}::${tiles}`;
}

function collectFrames(webContents) {
  const root = webContents && webContents.mainFrame;
  if (!root) return [];
  if (Array.isArray(root.framesInSubtree) && root.framesInSubtree.length) return [root, ...root.framesInSubtree];
  const frames = [root];
  const walk = (frame) => {
    for (const child of frame.frames || []) {
      frames.push(child);
      walk(child);
    }
  };
  walk(root);
  return frames;
}

function safeError(error) {
  return String(error && error.message || error || 'unknown error')
    .replace(/https?:\/\/[^\s@/]+:[^\s@/]+@[^\s/]+/gi, '<proxy>')
    .slice(0, 300);
}

class ManualCaptchaManager {
  constructor({ electron = null, pollIntervalMs = DEFAULT_POLL_MS, logger = console, autosolver = undefined } = {}) {
    this.electron = electron;
    this.pollIntervalMs = pollIntervalMs;
    this.logger = logger;
    this.pending = new Map();
    this.proxyAuth = new Map();
    this.loginApp = null;
    this.loginHandler = null;
    this.autosolver = autosolver === undefined ? loadAutosolver() : autosolver;
  }

  electronApi() {
    if (!this.electron) this.electron = require('electron');
    return this.electron;
  }

  installProxyAuth(app) {
    if (!app || this.loginApp === app) return;
    if (this.loginApp && this.loginHandler) this.loginApp.removeListener?.('login', this.loginHandler);
    this.loginHandler = (event, webContents, _details, authInfo, callback) => {
      const credentials = webContents && this.proxyAuth.get(webContents.id);
      if (!credentials || !authInfo || authInfo.isProxy !== true) return;
      event.preventDefault();
      callback(credentials.username, credentials.password);
    };
    app.on('login', this.loginHandler);
    this.loginApp = app;
  }

  async prepareSession(marker, electron) {
    const { solve, session } = marker;
    if (solve.proxy) {
      await session.setProxy({ mode: 'fixed_servers', proxyRules: solve.proxy.rules });
    } else {
      await session.setProxy({ mode: 'direct' });
    }
    for (const cookie of solve.cookies) {
      await session.cookies.set({
        url: POKEMON_CENTER_URL,
        name: cookie.name,
        value: cookie.value,
        path: '/',
        secure: true,
      }).catch(() => {});
    }
    const html = buildCaptchaHtml({
      ...solve,
      autosolve: !(marker.autosolveEnabled && marker.autosolveEnabled() === false),
    });
    await session.protocol.handle('https', request => {
      let requested;
      try { requested = new URL(request.url); } catch { requested = null; }
      if (requested && requested.href === POKEMON_CENTER_URL && request.method === 'GET') {
        return new Response(html, {
          status: 200,
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store, max-age=0',
          },
        });
      }
      return electron.net.fetch(request, { bypassCustomProtocolHandlers: true });
    });
  }

  createWindow(marker, electron, parent) {
    const partition = `zyn-captcha-${marker.id}`;
    const stackIndex = Math.max(0, this.pending.size - 1);
    const bounds = captchaWindowBounds(electron, parent, stackIndex);
    const window = new electron.BrowserWindow({
      ...bounds,
      minWidth: 440,
      minHeight: 560,
      show: false,
      parent: parent && !parent.isDestroyed?.() ? parent : undefined,
      modal: false,
      movable: true,
      title: 'Zyn · Captcha',
      backgroundColor: '#090b18',
      autoHideMenuBar: true,
      webPreferences: {
        partition,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        devTools: electron.app && electron.app.isPackaged !== true,
      },
    });
    marker.window = window;
    marker.session = window.webContents.session;
    if (marker.solve.proxy && (marker.solve.proxy.username || marker.solve.proxy.password)) {
      this.proxyAuth.set(window.webContents.id, marker.solve.proxy);
    }
    if (marker.solve.userAgent) window.webContents.setUserAgent(marker.solve.userAgent);
    window.webContents.setWindowOpenHandler?.(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, nextUrl) => {
      if (nextUrl !== POKEMON_CENTER_URL) event.preventDefault();
    });
    window.once('ready-to-show', () => {
      if (!marker.done && !window.isDestroyed()) { window.show(); window.focus(); }
    });
    window.on('closed', () => {
      marker.window = null;
      this.settle(marker, '', { closeWindow: false, notify: true });
    });
    return window;
  }

  async scrapeChallenge(webContents) {
    for (const frame of collectFrames(webContents)) {
      const url = String(frame.url || '');
      if (url && !/hcaptcha\.com/i.test(url)) continue;
      try {
        const challenge = await frame.executeJavaScript(SCRAPE_CHALLENGE, true);
        if (challenge && challenge.prompt && challenge.taskImages && challenge.taskImages.length) return challenge;
      } catch {}
    }
    return null;
  }

  async clickTiles(webContents, coords, cols) {
    for (const frame of collectFrames(webContents)) {
      const url = String(frame.url || '');
      if (url && !/hcaptcha\.com/i.test(url)) continue;
      try {
        const clicked = await frame.executeJavaScript(clickTilesScript(coords, cols), true);
        if (clicked) return true;
      } catch {}
    }
    return false;
  }

  setCaptchaStatus(webContents, text) {
    if (!webContents) return Promise.resolve();
    return webContents.executeJavaScript(
      `document.getElementById('status-text') && (document.getElementById('status-text').textContent = ${JSON.stringify(String(text))})`,
      true,
    ).catch(() => {});
  }

  handOffAutosolve(marker, key) {
    marker.autosolveHandedOff = true;
    if (key) marker.lastChallenge = key;
    return this.setCaptchaStatus(marker.window && marker.window.webContents, 'Complete the challenge to continue.');
  }

  async maybeAutosolve(marker) {
    if (marker.autosolveEnabled && marker.autosolveEnabled() === false) return;
    if (marker.autosolveHandedOff) return;
    if (!this.autosolver || marker.done || marker.autosolving || !marker.window || marker.window.isDestroyed()) return;
    const challenge = await this.scrapeChallenge(marker.window.webContents);
    if (!challenge) return;
    const key = challengeKey(challenge);
    if (!key || key === marker.lastChallenge) return;
    if (marker.autosolveSubmitted) {
      await this.handOffAutosolve(marker, key);
      return;
    }
    marker.lastChallenge = key;
    marker.autosolving = true;
    try {
      await this.setCaptchaStatus(marker.window.webContents, 'AutoSolve running…');
      const result = await this.autosolver.solve(challenge);
      if (marker.done) return;
      if (!result || !result.solvable || !result.coords.length) {
        await this.handOffAutosolve(marker, key);
        return;
      }
      await this.clickTiles(marker.window.webContents, result.coords, challenge.cols || 3);
      marker.autosolveSubmitted = true;
      await this.setCaptchaStatus(marker.window.webContents, 'Checking AutoSolve…');
    } catch (error) {
      marker.logger.warn?.(`[captcha] autosolve failed for task ${marker.solve.taskId}: ${safeError(error)}`);
      await this.handOffAutosolve(marker, key);
    } finally {
      marker.autosolving = false;
    }
  }

  startPolling(marker) {
    marker.pollTimer = setInterval(async () => {
      if (marker.done || marker.polling || !marker.window || marker.window.isDestroyed()) return;
      marker.polling = true;
      try {
        const state = await marker.window.webContents.executeJavaScript(`(() => ({
          token: String(window.__zynCaptchaToken || (window.hcaptcha && window.__zynCaptchaWidget != null
            ? window.hcaptcha.getResponse(window.__zynCaptchaWidget) : '') || ''),
          error17: /error\\s*17/i.test(document.body ? document.body.innerText : '')
        }))()`, true);
        const token = String(state && state.token || '').trim();
        if (token) {
          await this.settle(marker, token, { notify: true });
        } else if (state && state.error17 && !marker.reloadedForError17) {
          marker.reloadedForError17 = true;
          marker.window.webContents.reloadIgnoringCache();
        } else {
          await this.maybeAutosolve(marker);
        }
      } catch {}
      finally { marker.polling = false; }
    }, this.pollIntervalMs);
  }

  async open(solve, options) {
    const existing = this.pending.get(solve.taskId);
    if (existing) {
      try { existing.window?.show(); existing.window?.focus(); } catch {}
      return false;
    }
    const electron = this.electronApi();
    this.installProxyAuth(electron.app);
    const marker = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      solve,
      send: options.send,
      isActive: options.isActive || (() => true),
      autosolveEnabled: options.autosolveEnabled,
      logger: options.logger || this.logger,
      window: null,
      session: null,
      pollTimer: null,
      polling: false,
      autosolving: false,
      autosolveSubmitted: false,
      autosolveHandedOff: false,
      lastChallenge: '',
      reloadedForError17: false,
      done: false,
    };
    this.pending.set(solve.taskId, marker);
    try {
      const parent = options.parent || electron.BrowserWindow.getFocusedWindow?.();
      const window = this.createWindow(marker, electron, parent);
      await this.prepareSession(marker, electron);
      if (marker.done) return false;
      await window.loadURL(solve.siteUrl);
      if (marker.done) return false;
      this.startPolling(marker);
      return true;
    } catch (error) {
      marker.logger.warn?.(`[captcha] could not open solver for task ${solve.taskId}: ${safeError(error)}`);
      await this.settle(marker, '', { notify: true });
      return false;
    }
  }

  async settle(marker, token, { closeWindow = true, notify = false } = {}) {
    if (!marker || marker.done) return false;
    marker.done = true;
    if (marker.pollTimer) clearInterval(marker.pollTimer);
    marker.pollTimer = null;
    if (this.pending.get(marker.solve.taskId) === marker) this.pending.delete(marker.solve.taskId);
    const webContentsId = marker.window && marker.window.webContents && marker.window.webContents.id;
    if (webContentsId != null) this.proxyAuth.delete(webContentsId);
    let sent = false;
    if (notify && marker.isActive()) {
      try {
        sent = marker.send(contract.buildReceivedToken({
          taskId: marker.solve.taskId,
          token,
          site: marker.solve.site,
        })) !== false;
      } catch (error) {
        marker.logger.warn?.(`[captcha] could not return token for task ${marker.solve.taskId}: ${safeError(error)}`);
      }
    }
    if (closeWindow && marker.window && !marker.window.isDestroyed()) {
      try { marker.window.destroy(); } catch {}
    }
    try { await marker.session?.protocol?.unhandle?.('https'); } catch {}
    try { await marker.session?.clearStorageData?.(); } catch {}
    return sent;
  }

  async handleRequest(message, options = {}) {
    let solve;
    try { solve = normalizeSolve(message, options.registry); }
    catch (error) {
      (options.logger || this.logger).warn?.(`[captcha] rejected engine request: ${safeError(error)}`);
      return false;
    }
    return this.open(solve, options);
  }

  async handleEnvelope(envelope, options = {}) {
    let parsed;
    try { parsed = contract.parseEnvelope(envelope); }
    catch (error) {
      (options.logger || this.logger).warn?.(`[captcha] rejected engine envelope: ${safeError(error)}`);
      return false;
    }
    if (parsed.type !== 'solve-captcha') return false;
    await Promise.all(parsed.messages.map(message => this.handleRequest(message, options)));
    return true;
  }

  cancelTask(taskId) {
    const marker = this.pending.get(String(taskId == null ? '' : taskId).trim());
    return marker ? this.settle(marker, '', { notify: false }) : Promise.resolve(false);
  }

  async cancelPending() {
    await Promise.all([...this.pending.values()].map(marker => this.settle(marker, '', { notify: false })));
  }

  pendingCount() { return this.pending.size; }
}

const singleton = new ManualCaptchaManager();

module.exports = {
  handleEnvelope: (...args) => singleton.handleEnvelope(...args),
  cancelTask: (...args) => singleton.cancelTask(...args),
  cancelPending: (...args) => singleton.cancelPending(...args),
  __test: {
    ManualCaptchaManager,
    normalizeSolve,
    parseProxy,
    buildCaptchaHtml,
    challengeKey,
    captchaWindowBounds,
    loadAutosolver,
    singleton,
  },
};
