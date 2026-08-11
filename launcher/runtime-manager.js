'use strict';

// Ported from the established upstream runtime manager. Zyn keeps its resumable, signed-manifest protocol,
// but uses its own manifest path and environment namespace so an older desktop build can never
// receive a newer engine/runtime combination by accident.

const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const http = require('http');
const https = require('https');
const path = require('path');
const { execFile } = require('child_process');

const DEFAULT_RUNTIME_ORIGIN = 'https://updates.rcart.app';
const MANIFEST_PATH = '/runtimes/zyn-manifest-v1.json';

// Zyn runtime-manifest public key. Its Ed25519 private half is stored only in the release owner's
// login Keychain under com.thwebco.zyn.runtime-signing/manifest-private-key.
const MANIFEST_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAbxrlW2wsfr/+kl/nA6KVcK6AExOHXJPCRgwyQ461C2w=
-----END PUBLIC KEY-----`;

const PLATFORM_COMPONENTS = Object.freeze({
  darwin: ['chromium'],
  win32: ['chromium'],
});
const EXPECTED_CHROMIUM_REVISION = '1228';
const RUNTIME_NAMES = new Set(['chromium']);
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const MAX_MANIFEST_BYTES = 1024 * 1024;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function exec(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { ...options, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function request(url, { headers = {}, timeout = 30000, redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    if (!['https:', 'http:'].includes(target.protocol)) {
      reject(new Error(`Unsupported runtime URL protocol: ${target.protocol}`));
      return;
    }
    const transport = target.protocol === 'https:' ? https : http;
    const req = transport.get(target, { headers }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        if (redirects <= 0) {
          reject(new Error('Too many runtime download redirects.'));
          return;
        }
        resolve(request(new URL(response.headers.location, target).toString(), {
          headers,
          timeout,
          redirects: redirects - 1,
        }));
        return;
      }
      resolve(response);
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error('Runtime download timed out.')));
  });
}

async function fetchJson(url) {
  const response = await request(url, {
    headers: { accept: 'application/json', 'cache-control': 'no-cache' },
  });
  if (response.statusCode !== 200) {
    response.resume();
    throw new Error(`Runtime manifest returned HTTP ${response.statusCode}.`);
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of response) {
    length += chunk.length;
    if (length > MAX_MANIFEST_BYTES) throw new Error('Runtime manifest is unexpectedly large.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Runtime manifest is not valid JSON.');
  }
}

function verifyManifest(document, publicKey = MANIFEST_PUBLIC_KEY) {
  if (!document || document.schema !== 1 || !document.payload || typeof document.signature !== 'string') {
    throw new Error('Runtime manifest has an unsupported format.');
  }
  const valid = crypto.verify(
    null,
    Buffer.from(JSON.stringify(document.payload)),
    publicKey,
    Buffer.from(document.signature, 'base64'),
  );
  if (!valid) throw new Error('Runtime manifest signature is invalid.');
  return document.payload;
}

async function sha256(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function safeRelative(relative) {
  if (!relative || path.isAbsolute(relative)) return false;
  return !relative.split(/[\\/]+/).some((part) => part === '..' || part === '');
}

function safeItem(name, item) {
  if (!RUNTIME_NAMES.has(name) || !item || typeof item !== 'object') return false;
  return SAFE_SEGMENT.test(String(item.version || ''))
    && SAFE_SEGMENT.test(String(item.archive || ''))
    && /^[a-f0-9]{64}$/.test(String(item.sha256 || ''))
    && Number.isSafeInteger(item.size) && item.size > 0
    && typeof item.url === 'string' && item.url.length < 1000
    && safeRelative(item.entry)
    && safeRelative(item.verify)
    && (!item.format || ['tar.xz', 'tar.gz'].includes(item.format));
}

class RuntimeManager {
  constructor(options = {}) {
    this.app = options.app;
    this.log = options.log || console;
    this.platform = options.platform || process.platform;
    this.arch = options.arch || process.arch;
    this.platformKey = options.platformKey || `${this.platform}-${this.arch}`;
    this.enabled = options.enabled !== undefined
      ? Boolean(options.enabled)
      : Boolean(PLATFORM_COMPONENTS[this.platform] && this.app && this.app.isPackaged);
    this.origin = String(options.origin || DEFAULT_RUNTIME_ORIGIN).replace(/\/+$/, '');
    this.manifestUrl = options.manifestUrl || `${this.origin}${MANIFEST_PATH}`;
    this.root = options.root || path.join(this.app.getPath('userData'), 'runtimes');
    this.publicKey = options.publicKey || MANIFEST_PUBLIC_KEY;
    this.verifyArtifact = typeof options.verifyArtifact === 'function' ? options.verifyArtifact : null;
    this.checkRosetta = typeof options.checkRosetta === 'function' ? options.checkRosetta : null;
    this.onStatus = typeof options.onStatus === 'function' ? options.onStatus : () => {};
    this.currentDocument = null;
    this.currentPayload = null;
    this.currentItems = {};
    this.ensurePromise = null;
    this.status = {
      enabled: this.enabled,
      platform: this.platformKey,
      state: this.enabled ? 'checking' : 'ready',
      ready: !this.enabled,
      percent: this.enabled ? 0 : 100,
      downloadedBytes: 0,
      totalBytes: 0,
      message: this.enabled ? 'Checking runtime components…' : 'Runtime download is not required for this build.',
      items: {},
    };
  }

  getStatus() {
    return clone(this.status);
  }

  emit(patch = {}) {
    this.status = { ...this.status, ...patch };
    const items = Object.values(this.status.items || {});
    const totalBytes = items.reduce((sum, item) => sum + (Number(item.size) || 0), 0);
    const downloadedBytes = items.reduce((sum, item) => {
      if (item.state === 'ready' || item.state === 'installing') return sum + (Number(item.size) || 0);
      return sum + Math.min(Number(item.downloadedBytes) || 0, Number(item.size) || 0);
    }, 0);
    const ready = !this.enabled || (Boolean(items.length) && items.every((item) => item.state === 'ready'));
    let percent = totalBytes ? Math.floor((downloadedBytes / totalBytes) * 100) : (ready ? 100 : 0);
    if (!ready && percent >= 100) percent = 99;
    this.status = { ...this.status, totalBytes, downloadedBytes, percent, ready };
    try { this.onStatus(this.getStatus()); } catch {}
    return this.getStatus();
  }

  item(name, patch = {}) {
    const labels = { chromium: 'Chromium' };
    const current = this.status.items[name] || { name, label: labels[name] || name };
    this.status.items = { ...this.status.items, [name]: { ...current, ...patch } };
    return this.emit();
  }

  async initialize() {
    await fsp.mkdir(this.root, { recursive: true });
    if (!this.enabled) return this.getStatus();
    try {
      const raw = await fsp.readFile(path.join(this.root, 'manifest.json'), 'utf8');
      const document = JSON.parse(raw);
      const payload = verifyManifest(document, this.publicKey);
      this.setManifest(document, payload);
      await this.reconcile();
    } catch (error) {
      if (error && error.code !== 'ENOENT') this.log.warn?.(`[runtime] cached manifest: ${error.message}`);
      this.emit({ state: 'idle', ready: false, message: 'Runtime components will download after sign-in.' });
    }
    return this.getStatus();
  }

  setManifest(document, payload) {
    const platform = payload && payload.platforms && payload.platforms[this.platformKey];
    if (!platform || typeof platform !== 'object') {
      throw new Error(`Runtime manifest does not support ${this.platformKey}.`);
    }
    const names = PLATFORM_COMPONENTS[this.platform] || [];
    const runtimeItems = { ...platform };
    for (const name of names) {
      if (!safeItem(name, runtimeItems[name])) {
        throw new Error(`Runtime manifest has an invalid ${name} entry.`);
      }
      const target = new URL(runtimeItems[name].url, `${this.origin}/`);
      const localFixture = target.protocol === 'http:' && target.hostname === '127.0.0.1';
      if (target.protocol !== 'https:' && !localFixture) {
        throw new Error(`Runtime manifest has an unsafe ${name} URL.`);
      }
    }
    if (!runtimeItems.chromium.entry.includes(`/chromium-${EXPECTED_CHROMIUM_REVISION}/`)) {
      throw new Error('Runtime manifest Chromium does not match this Zyn build’s Playwright revision.');
    }
    this.currentDocument = document;
    this.currentPayload = payload;
    this.currentItems = Object.fromEntries(names.map((name) => [name, runtimeItems[name]]));
    this.status.items = Object.fromEntries(names.map((name) => {
      const item = runtimeItems[name];
      return [name, {
        name,
        label: item.label || name,
        version: item.version,
        size: item.size,
        downloadedBytes: 0,
        state: 'pending',
        detail: `Waiting · ${formatBytes(item.size)}`,
      }];
    }));
    this.emit({ state: 'checking', message: 'Checking runtime components…' });
  }

  installDir(name, item) {
    return path.join(this.root, name, item.version);
  }

  markerPath(name, item) {
    return path.join(this.installDir(name, item), '.ready.json');
  }

  async installed(name, item) {
    try {
      const marker = JSON.parse(await fsp.readFile(this.markerPath(name, item), 'utf8'));
      if (marker.version !== item.version || marker.sha256 !== item.sha256) return false;
      return fs.existsSync(path.join(this.installDir(name, item), item.entry));
    } catch {
      return false;
    }
  }

  activate(name, item) {
    const directory = this.installDir(name, item);
    if (name === 'chromium') {
      process.env.ZYN_PLAYWRIGHT_BROWSERS_PATH = path.join(directory, item.root || 'ms-playwright');
    }
  }

  async hostRequirementError() {
    return null;
  }

  async reconcile() {
    if (!this.currentPayload) return this.getStatus();
    let allReady = true;
    let requirementError = '';
    for (const [name, item] of Object.entries(this.currentItems)) {
      const ready = await this.installed(name, item);
      allReady = allReady && ready;
      if (!ready) continue;
      this.activate(name, item);
      const error = await this.hostRequirementError(name, item);
      if (error) {
        allReady = false;
        requirementError = error;
        this.item(name, { state: 'blocked', downloadedBytes: item.size, detail: 'Rosetta 2 required' });
      } else {
        this.item(name, { state: 'ready', downloadedBytes: item.size, detail: `Ready · ${item.version}` });
      }
    }
    return this.emit({
      state: allReady ? 'ready' : (requirementError ? 'error' : 'idle'),
      error: requirementError,
      message: allReady ? 'Runtime components are ready.'
        : (requirementError || 'Runtime components will download after sign-in.'),
    });
  }

  async cacheManifest(document) {
    const temporary = path.join(this.root, `manifest.${process.pid}.tmp`);
    await fsp.writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    await fsp.rename(temporary, path.join(this.root, 'manifest.json'));
  }

  async ensureAll({ force = false } = {}) {
    if (!this.enabled) return this.getStatus();
    if (this.ensurePromise) return this.ensurePromise;
    this.ensurePromise = this.runEnsure().finally(() => { this.ensurePromise = null; });
    return this.ensurePromise;
  }

  async runEnsure() {
    this.emit({ state: 'checking', message: 'Checking runtime components…', error: '' });
    try {
      try {
        const document = await fetchJson(this.manifestUrl);
        const payload = verifyManifest(document, this.publicKey);
        this.setManifest(document, payload);
        await this.cacheManifest(document);
      } catch (error) {
        if (!this.currentPayload) throw error;
        this.log.warn?.(`[runtime] remote manifest unavailable; using cached manifest: ${error.message}`);
      }

      await this.reconcile();
      for (const [name, item] of Object.entries(this.currentItems)) {
        if (!(await this.installed(name, item))) await this.downloadAndInstall(name, item);
      }
      const finalStatus = await this.reconcile();
      if (finalStatus.state === 'error' && finalStatus.error) throw new Error(finalStatus.error);
      return finalStatus;
    } catch (error) {
      this.log.error?.(`[runtime] setup failed: ${error.stack || error.message}`);
      const rosetta = /rosetta/i.test(String(error.message || ''));
      this.emit({
        state: 'error',
        ready: false,
        error: error.message,
        message: rosetta
          ? 'Runtime setup requires Rosetta 2. Install Rosetta, then click Retry.'
          : 'Runtime setup could not finish. Check your connection, then click Retry.',
      });
      throw error;
    }
  }

  async downloadAndInstall(name, item) {
    const downloads = path.join(this.root, '.downloads');
    await fsp.mkdir(downloads, { recursive: true });
    const partial = path.join(downloads, `${item.archive}.partial`);
    const archive = path.join(downloads, item.archive);
    const targetUrl = new URL(item.url, `${this.origin}/`).toString();
    let existing = 0;
    try { existing = (await fsp.stat(partial)).size; } catch {}
    if (existing > item.size) {
      await fsp.unlink(partial).catch(() => {});
      existing = 0;
    }

    this.item(name, {
      state: 'downloading',
      downloadedBytes: existing,
      detail: `Downloading ${formatBytes(existing)} of ${formatBytes(item.size)}`,
    });
    this.emit({ state: 'downloading', message: 'Downloading Runtime…' });
    await this.download(targetUrl, partial, item, name, existing);

    const actualHash = await sha256(partial);
    const stat = await fsp.stat(partial);
    if (stat.size !== item.size) throw new Error(`${item.label || name} size did not match the signed manifest.`);
    if (actualHash !== item.sha256) throw new Error(`${item.label || name} failed its integrity check.`);
    await fsp.rename(partial, archive);

    this.item(name, { state: 'installing', downloadedBytes: item.size, detail: 'Verifying and installing…' });
    this.emit({ state: 'installing', message: 'Installing Runtime…' });
    await this.extractAndVerify(name, item, archive);
    await fsp.unlink(archive).catch(() => {});
    this.activate(name, item);
    this.item(name, { state: 'ready', downloadedBytes: item.size, detail: `Ready · ${item.version}` });
  }

  async download(targetUrl, partial, item, name, existing) {
    const headers = existing ? { range: `bytes=${existing}-` } : {};
    const response = await request(targetUrl, { headers, timeout: 60000 });
    if (response.statusCode === 416 && existing) {
      response.resume();
      await fsp.unlink(partial).catch(() => {});
      return this.download(targetUrl, partial, item, name, 0);
    }
    if (![200, 206].includes(response.statusCode)) {
      response.resume();
      throw new Error(`${item.label || name} download returned HTTP ${response.statusCode}.`);
    }
    const resumed = response.statusCode === 206 && existing > 0;
    let received = resumed ? existing : 0;
    const output = fs.createWriteStream(partial, { flags: resumed ? 'a' : 'w', mode: 0o600 });
    let lastEmit = 0;
    await new Promise((resolve, reject) => {
      const fail = (error) => {
        response.destroy();
        output.destroy();
        reject(error);
      };
      output.on('error', fail);
      response.on('error', fail);
      response.on('data', (chunk) => {
        received += chunk.length;
        const now = Date.now();
        if (now - lastEmit >= 150 || received >= item.size) {
          lastEmit = now;
          this.item(name, {
            state: 'downloading',
            downloadedBytes: received,
            detail: `Downloading ${formatBytes(received)} of ${formatBytes(item.size)}`,
          });
        }
      });
      output.on('finish', resolve);
      response.pipe(output);
    });
  }

  async extractAndVerify(name, item, archive) {
    const format = item.format || 'tar.xz';
    const listArgs = format === 'tar.gz' ? ['-tzf', archive] : ['-tJf', archive];
    const tar = this.platform === 'win32' ? 'tar.exe' : '/usr/bin/tar';
    const listing = await exec(tar, listArgs);
    const entries = listing.stdout.split(/\r?\n/).filter(Boolean);
    if (!entries.length || entries.some((entry) => path.isAbsolute(entry)
      || entry.split(/[\\/]+/).some((part) => part === '..'))) {
      throw new Error(`${item.label || name} archive contains an unsafe path.`);
    }

    const parent = path.join(this.root, name);
    await fsp.mkdir(parent, { recursive: true });
    const staging = await fsp.mkdtemp(path.join(parent, `.${item.version}-`));
    try {
      const extractArgs = format === 'tar.gz'
        ? ['-xzf', archive, '-C', staging]
        : ['-xJf', archive, '-C', staging];
      await exec(tar, extractArgs);
      const entry = path.join(staging, item.entry);
      const verifyTarget = path.join(staging, item.verify);
      if (!fs.existsSync(entry) || !fs.existsSync(verifyTarget)) {
        throw new Error(`${item.label || name} archive is incomplete.`);
      }

      if (this.verifyArtifact) {
        await this.verifyArtifact({ name, item, entry, verifyTarget, staging });
      } else if (this.platform === 'win32') {
        // Windows releases are intentionally unsigned for now. The signed Ed25519 manifest pins
        // the complete archive hash; this PE header check prevents a malformed archive from being
        // marked ready after extraction while preserving the expected SmartScreen warning.
        const handle = await fsp.open(entry, 'r');
        const header = Buffer.alloc(2);
        try { await handle.read(header, 0, header.length, 0); } finally { await handle.close(); }
        if (!header.equals(Buffer.from('MZ'))) {
          throw new Error(`${item.label || name} executable is not a Windows PE file.`);
        }
      } else {
        await exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', verifyTarget]);
        const details = await exec('/usr/bin/codesign', ['-dvvv', verifyTarget]);
        const signingInfo = `${details.stdout}\n${details.stderr}`;
        if (!/TeamIdentifier=GXWBXH5M77/.test(signingInfo)) {
          throw new Error(`${item.label || name} is not signed by Zyn's Developer ID team.`);
        }
      }

      await fsp.writeFile(path.join(staging, '.ready.json'), `${JSON.stringify({
        version: item.version,
        sha256: item.sha256,
        installedAt: new Date().toISOString(),
      }, null, 2)}\n`, { mode: 0o600 });
      const finalDirectory = this.installDir(name, item);
      await fsp.rm(finalDirectory, { recursive: true, force: true });
      await fsp.rename(staging, finalDirectory);
    } catch (error) {
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async waitFor(names = Object.keys(this.currentItems)) {
    if (!this.enabled) return this.getStatus();
    const required = [...new Set(names)];
    if (required.every((name) => this.status.items[name]?.state === 'ready')) return this.getStatus();
    await this.ensureAll();
    const missing = required.filter((name) => this.status.items[name]?.state !== 'ready');
    if (missing.length) throw new Error(`Required runtime components are not ready: ${missing.join(', ')}.`);
    return this.getStatus();
  }
}

module.exports = {
  RuntimeManager,
  DEFAULT_RUNTIME_ORIGIN,
  MANIFEST_PATH,
  MANIFEST_PUBLIC_KEY,
  PLATFORM_COMPONENTS,
  verifyManifest,
};
