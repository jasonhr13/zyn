// Cloudflare license API client for Electron's main process. Authentication tokens never cross
// the preload bridge; electron.js stores them with safeStorage and only returns renderer-safe
// status objects.
const os = require('os');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { execFileSync } = require('child_process');
const { URL } = require('url');
const WebSocket = require('ws');

const DEFAULT_API_BASE = 'https://license.zynbot.app';
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_QUEUE_EVENT_BYTES = 64 * 1024;
// Preserve the established device namespace so existing license/device bindings survive rebranding.
const DEVICE_NAMESPACE = String.fromCharCode(104, 111, 112, 101);

function machineGuid() {
  if (process.platform !== 'win32') return '';
  try {
    const out = execFileSync(
      'reg',
      ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
      { encoding: 'utf8', timeout: 3000, windowsHide: true },
    );
    const match = out.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]{36})/);
    return match ? match[1] : '';
  } catch {
    return '';
  }
}

function computeHwid() {
  const guid = machineGuid();
  if (guid) return crypto.createHash('sha256').update(`${DEVICE_NAMESPACE}:${guid}`).digest('hex').slice(0, 32);
  const macs = Object.values(os.networkInterfaces())
    .flat()
    .filter((item) => item && !item.internal && item.mac && item.mac !== '00:00:00:00:00:00')
    .map((item) => item.mac)
    .sort();
  const cpu = (os.cpus()[0] || {}).model || '';
  const parts = [os.platform(), os.arch(), os.hostname(), cpu, macs[0] || '', String(os.totalmem())];
  return crypto.createHash('sha256').update(`${DEVICE_NAMESPACE}:${parts.join('|')}`).digest('hex').slice(0, 32);
}

function requestApi(apiBase, pathname, {
  method = 'GET', body = null, token = '', headers = {}, binary = false, rawResponse = false,
} = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null
      ? null
      : (Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), 'utf8'));
    const target = new URL(pathname, `${apiBase.replace(/\/$/, '')}/`);
    if (!['https:', 'http:'].includes(target.protocol)) {
      reject(new Error('unsupported license server protocol'));
      return;
    }
    const transport = target.protocol === 'https:' ? https : http;
    const request = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method,
      headers: {
        ...(data ? {
          'content-type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json',
          'content-length': data.length,
        } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
    }, (response) => {
      const chunks = [];
      let responseBytes = 0;
      response.on('data', (chunk) => {
        const bytes = Buffer.from(chunk);
        chunks.push(bytes);
        responseBytes += bytes.length;
        if (responseBytes > MAX_RESPONSE_BYTES) {
          response.destroy(new Error('server response was unexpectedly large'));
        }
      });
      response.on('error', reject);
      response.on('end', () => {
        const raw = Buffer.concat(chunks);
        if (binary && response.statusCode >= 200 && response.statusCode < 300) {
          resolve({ ok: true, status: response.statusCode || 0, buffer: raw, headers: response.headers });
          return;
        }
        let parsed = {};
        try { parsed = JSON.parse(raw.toString('utf8')); } catch {}
        if (rawResponse) {
          resolve({
            ok: response.statusCode >= 200 && response.statusCode < 300,
            status: response.statusCode || 0,
            body: raw.toString('utf8'),
            headers: response.headers,
            code: String(parsed.code || ''),
            message: String(parsed.message || ''),
          });
          return;
        }
        resolve({ status: response.statusCode || 0, ...parsed });
      });
    });
    request.on('error', reject);
    request.setTimeout(30000, () => request.destroy(new Error('server request timed out')));
    if (data) request.write(data);
    request.end();
  });
}

function post(apiBase, pathname, body, token = '') {
  return requestApi(apiBase, pathname, { method: 'POST', body: body || {}, token });
}

function analyticsQuery(pathname, query = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== '' && value != null) params.set(key, String(value));
  }
  const suffix = params.toString();
  return suffix ? `${pathname}?${suffix}` : pathname;
}

function createClient({ apiBase = DEFAULT_API_BASE } = {}) {
  const deviceId = computeHwid();
  const deviceName = os.hostname().slice(0, 100);
  return {
    deviceId,
    login(email, password) {
      return post(apiBase, '/api/auth/login', { email, password, deviceId, deviceName });
    },
    resetPassword(resetToken, newPassword) {
      return post(apiBase, '/api/auth/reset-password', { resetToken, newPassword, deviceId, deviceName });
    },
    validate(token, proxyRevision = '') {
      return post(apiBase, '/api/license/validate', { deviceId, proxyRevision }, token);
    },
    logout(token) {
      return post(apiBase, '/api/auth/logout', {}, token);
    },
    hyper(token, operation, payload) {
      const allowed = new Set([
        'reese84', 'datadome-tags', 'datadome-interstitial', 'datadome-slider', 'incapsula-utmvc',
      ]);
      if (!allowed.has(operation)) return Promise.reject(new Error('unsupported Hyper operation'));
      return requestApi(apiBase, `/api/services/hyper/${operation}`, {
        method: 'POST',
        body: payload || {},
        token,
        rawResponse: true,
        headers: { 'x-rcart-device-id': deviceId },
      });
    },
    queueEvents(token, handlers = {}) {
      const target = new URL('/api/services/pokemon-center/queue-events', `${apiBase.replace(/\/$/, '')}/`);
      target.protocol = target.protocol === 'http:' ? 'ws:' : 'wss:';
      const socket = new WebSocket(target, {
        headers: {
          authorization: `Bearer ${String(token || '')}`,
          'x-rcart-device-id': deviceId,
        },
        followRedirects: false,
        handshakeTimeout: 15000,
        maxPayload: MAX_QUEUE_EVENT_BYTES,
        perMessageDeflate: false,
      });
      if (typeof handlers.open === 'function') socket.on('open', handlers.open);
      if (typeof handlers.close === 'function') socket.on('close', handlers.close);
      if (typeof handlers.error === 'function') socket.on('error', handlers.error);
      if (typeof handlers.message === 'function') {
        socket.on('message', (data) => {
          const bytes = Buffer.from(data);
          if (bytes.length > MAX_QUEUE_EVENT_BYTES) return;
          let message;
          try { message = JSON.parse(bytes.toString('utf8')); } catch { return; }
          if (message && typeof message === 'object' && !Array.isArray(message)) handlers.message(message);
        });
      }
      return socket;
    },
    listBackups(token) {
      return requestApi(apiBase, '/api/backups', {
        token,
        headers: { 'x-rcart-device-id': deviceId },
      });
    },
    uploadBackup(token, encrypted, metadata = {}) {
      return requestApi(apiBase, `/api/backups/${encodeURIComponent(String(metadata.backupId || ''))}`, {
        method: 'PUT',
        body: Buffer.from(encrypted),
        token,
        headers: {
          'x-rcart-device-id': deviceId,
          'x-rcart-created-at': String(Number(metadata.createdAt) || Date.now()),
          'x-rcart-key-fingerprint': String(metadata.keyFingerprint || ''),
          'x-rcart-app-version': String(metadata.appVersion || '').slice(0, 40),
        },
      });
    },
    downloadBackup(token, backupId) {
      return requestApi(apiBase, `/api/backups/${encodeURIComponent(String(backupId || ''))}`, {
        token,
        binary: true,
        headers: { 'x-rcart-device-id': deviceId },
      });
    },
    deleteBackup(token, backupId) {
      return requestApi(apiBase, `/api/backups/${encodeURIComponent(String(backupId || ''))}`, {
        method: 'DELETE',
        token,
        headers: { 'x-rcart-device-id': deviceId },
      });
    },
    analyticsEvents(token, events) {
      return requestApi(apiBase, '/api/analytics/events', {
        method: 'POST', body: { events: Array.isArray(events) ? events : [] }, token,
        headers: { 'x-rcart-device-id': deviceId },
      });
    },
    analyticsDashboard(token, query = {}) {
      return requestApi(apiBase, analyticsQuery('/api/analytics/dashboard', query), {
        token, headers: { 'x-rcart-device-id': deviceId },
      });
    },
    analyticsCheckouts(token, query = {}) {
      return requestApi(apiBase, analyticsQuery('/api/analytics/checkouts', query), {
        token, headers: { 'x-rcart-device-id': deviceId },
      });
    },
    deleteAnalytics(token) {
      return requestApi(apiBase, '/api/analytics', {
        method: 'DELETE', token, headers: { 'x-rcart-device-id': deviceId },
      });
    },
  };
}

module.exports = { createClient, computeHwid, DEFAULT_API_BASE, __test: { requestApi, analyticsQuery } };
