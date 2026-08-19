'use strict';

// HTTP/SOCKS health checks for persisted proxy lists. This is request latency through the
// proxy, not ICMP ping — HTTP proxies cannot forward ping.
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const tls = require('tls');
const { URL } = require('url');

const TEST_FILE = 'proxy-tests.json';
const FULL_TEST_LIMIT = 250;
const SAMPLE_SIZE = 100;
const CONCURRENCY = 20;
const TIMEOUT_MS = 5000;
const PROBE_URL = 'https://cloudflare.com/cdn-cgi/trace';
const ROW_CAP = 500;
const VALID_PROTOCOLS = new Set(['http:', 'https:', 'socks4:', 'socks5:']);

function validPort(value) {
  const port = Number.parseInt(String(value || ''), 10);
  return Number.isInteger(port) && port > 0 && port <= 65535;
}

function decoded(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function parseProxyLine(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;

  if (value.includes('://')) {
    try {
      const url = new URL(value);
      if (!VALID_PROTOCOLS.has(url.protocol) || !url.hostname || !validPort(url.port)) return null;
      const host = url.hostname.includes(':') ? `[${url.hostname}]` : url.hostname;
      return {
        server: `${url.protocol}//${host}:${url.port}`,
        username: decoded(url.username || ''),
        password: decoded(url.password || ''),
      };
    } catch { return null; }
  }

  const ipv6 = value.match(/^\[([^\]]+)\]:(\d+)(?::([^:]*)(?::(.*))?)?$/);
  if (ipv6) {
    if (!validPort(ipv6[2])) return null;
    return { server: `[${ipv6[1]}]:${ipv6[2]}`, username: ipv6[3] || '', password: ipv6[4] || '' };
  }

  const parts = value.split(':');
  const host = parts.shift() || '';
  const port = parts.shift() || '';
  if (!host || !validPort(port)) return null;
  const username = parts.shift() || '';
  return { server: `${host}:${port}`, username, password: parts.join(':') };
}

function lineKey(raw) {
  return crypto.createHash('sha256').update(String(raw || '')).digest('hex').slice(0, 16);
}

function displayHost(parsed, raw) {
  if (!parsed) {
    const text = String(raw || '').trim();
    return text.length > 48 ? `${text.slice(0, 45)}…` : text;
  }
  const server = String(parsed.server || '').replace(/^https?:\/\//, '');
  return parsed.username ? `${server} · auth` : server;
}

function isSocks(parsed) {
  return /^socks[45]?:/i.test(String(parsed && parsed.server || ''));
}

function speedBucket(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return '';
  if (value < 200) return 'fast';
  if (value < 500) return 'medium';
  return 'slow';
}

function percentile(values, p) {
  const nums = (Array.isArray(values) ? values : [])
    .map(Number)
    .filter(value => Number.isFinite(value))
    .sort((left, right) => left - right);
  if (!nums.length) return null;
  const index = Math.min(nums.length - 1, Math.max(0, Math.ceil((p / 100) * nums.length) - 1));
  return nums[index];
}

function pickSample(items, size, random = Math.random) {
  const list = Array.isArray(items) ? items.slice() : [];
  const take = Math.max(0, Math.min(list.length, Number(size) || 0));
  if (list.length <= take) return list;
  for (let index = list.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Number(random()) * (index + 1));
    const current = list[index];
    list[index] = list[swap];
    list[swap] = current;
  }
  return list.slice(0, take);
}

function resolveMode(total, requested) {
  const mode = String(requested || 'auto').toLowerCase();
  if (mode === 'full' || mode === 'sample') return mode;
  return total <= FULL_TEST_LIMIT ? 'full' : 'sample';
}

function splitHostPort(server) {
  const value = String(server || '').replace(/^https?:\/\//, '');
  const ipv6 = value.match(/^\[([^\]]+)\]:(\d+)$/);
  if (ipv6) return { host: ipv6[1], port: Number(ipv6[2]) };
  const sep = value.lastIndexOf(':');
  if (sep <= 0) return null;
  const host = value.slice(0, sep);
  const port = Number(value.slice(sep + 1));
  if (!host || !validPort(port)) return null;
  return { host, port };
}

function emptySummary(ref = '') {
  return {
    ref: String(ref || ''),
    updatedAt: 0,
    mode: '',
    running: false,
    total: 0,
    sampled: 0,
    tested: 0,
    working: 0,
    failed: 0,
    invalid: 0,
    p50: null,
    p95: null,
  };
}

function summarize(partial = {}) {
  const latencies = Array.isArray(partial.latencies) ? partial.latencies : [];
  return {
    ...emptySummary(partial.ref),
    updatedAt: Number(partial.updatedAt) || 0,
    mode: partial.mode === 'full' || partial.mode === 'sample' ? partial.mode : '',
    running: partial.running === true,
    total: Math.max(0, Number(partial.total) || 0),
    sampled: Math.max(0, Number(partial.sampled) || 0),
    tested: Math.max(0, Number(partial.tested) || 0),
    working: Math.max(0, Number(partial.working) || 0),
    failed: Math.max(0, Number(partial.failed) || 0),
    invalid: Math.max(0, Number(partial.invalid) || 0),
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
  };
}

function probeHttpConnect(parsed, { url, timeoutMs, signal } = {}) {
  const target = new URL(url || PROBE_URL);
  const endpoint = splitHostPort(parsed.server);
  if (!endpoint) return Promise.resolve({ ok: false, error: 'invalid proxy host', ms: 0 });
  const started = Date.now();
  return new Promise(resolve => {
    let settled = false;
    let socket;
    let tlsSocket;
    const finish = result => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      clearTimeout(timer);
      try { tlsSocket?.destroy(); } catch {}
      try { socket?.destroy(); } catch {}
      resolve({ ...result, ms: Date.now() - started });
    };
    const onAbort = () => finish({ ok: false, error: 'cancelled' });
    const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), timeoutMs || TIMEOUT_MS);
    if (signal) {
      if (signal.aborted) return finish({ ok: false, error: 'cancelled' });
      signal.addEventListener('abort', onAbort, { once: true });
    }

    socket = net.connect({ host: endpoint.host, port: endpoint.port }, () => {
      const destPort = target.port || (target.protocol === 'http:' ? 80 : 443);
      const auth = parsed.username
        ? `Proxy-Authorization: Basic ${Buffer.from(`${parsed.username}:${parsed.password}`).toString('base64')}\r\n`
        : '';
      socket.write(
        `CONNECT ${target.hostname}:${destPort} HTTP/1.1\r\n`
        + `Host: ${target.hostname}:${destPort}\r\n`
        + auth
        + 'Connection: close\r\n\r\n',
      );
    });
    socket.setNoDelay(true);
    socket.once('error', error => finish({ ok: false, error: error.message || 'connect failed' }));

    let header = '';
    const onData = chunk => {
      header += chunk.toString('latin1');
      const split = header.indexOf('\r\n\r\n');
      if (split < 0) return;
      socket.removeListener('data', onData);
      const status = header.slice(0, split).split('\r\n')[0] || '';
      if (!/ 200 /.test(status)) {
        finish({ ok: false, error: status.trim() || 'proxy refused CONNECT' });
        return;
      }
      const leftover = header.slice(split + 4);
      if (target.protocol === 'http:') {
        const request = http.request({
          createConnection: () => socket,
          host: target.hostname,
          path: `${target.pathname}${target.search}`,
          method: 'GET',
          headers: { Host: target.host, Connection: 'close' },
        }, response => {
          response.resume();
          response.on('end', () => {
            const code = Number(response.statusCode);
            finish(code >= 200 && code < 500
              ? { ok: true }
              : { ok: false, error: `HTTP ${code}` });
          });
        });
        request.on('error', error => finish({ ok: false, error: error.message || 'request failed' }));
        if (leftover) socket.unshift(Buffer.from(leftover, 'latin1'));
        request.end();
        return;
      }
      tlsSocket = tls.connect({
        socket,
        servername: target.hostname,
        ALPNProtocols: ['http/1.1'],
      }, () => {
        const request = http.request({
          createConnection: () => tlsSocket,
          host: target.hostname,
          path: `${target.pathname}${target.search}`,
          method: 'GET',
          headers: { Host: target.host, Connection: 'close' },
        }, response => {
          response.resume();
          response.on('end', () => {
            const code = Number(response.statusCode);
            finish(code >= 200 && code < 500
              ? { ok: true }
              : { ok: false, error: `HTTP ${code}` });
          });
        });
        request.on('error', error => finish({ ok: false, error: error.message || 'request failed' }));
        if (leftover) tlsSocket.unshift(Buffer.from(leftover, 'latin1'));
        request.end();
      });
      tlsSocket.once('error', error => finish({ ok: false, error: error.message || 'tls failed' }));
    };
    socket.on('data', onData);
  });
}

async function defaultProbe(parsed, options = {}) {
  if (isSocks(parsed)) {
    return { ok: false, error: 'SOCKS test is not supported yet', ms: 0 };
  }
  return probeHttpConnect(parsed, options);
}

async function mapPool(items, limit, worker, isCancelled) {
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length);
  let next = 0;
  const run = async () => {
    while (!isCancelled()) {
      const index = next;
      next += 1;
      if (index >= list.length) return;
      results[index] = await worker(list[index], index);
    }
  };
  const width = Math.max(1, Math.min(Number(limit) || 1, list.length || 1));
  await Promise.all(Array.from({ length: list.length ? width : 0 }, run));
  return results;
}

function createProxyTestControl({
  dataDirectory,
  getProxyLines,
  probe = defaultProbe,
  random = Math.random,
  now = Date.now,
  concurrency = CONCURRENCY,
  timeoutMs = TIMEOUT_MS,
  probeUrl = PROBE_URL,
  fullLimit = FULL_TEST_LIMIT,
  sampleSize = SAMPLE_SIZE,
} = {}) {
  if (!dataDirectory) throw new Error('proxy test dataDirectory is required');
  if (typeof getProxyLines !== 'function') throw new Error('proxy test getProxyLines is required');

  const filePath = path.join(dataDirectory, TEST_FILE);
  let running = null;

  const readStore = () => {
    try {
      const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const lists = value.lists && typeof value.lists === 'object' && !Array.isArray(value.lists)
          ? value.lists : {};
        return { lists };
      }
    } catch {}
    return { lists: {} };
  };

  const writeStore = store => {
    fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    const temporary = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, filePath);
    try { fs.chmodSync(filePath, 0o600); } catch {}
  };

  const linesFor = ref => {
    try {
      return (getProxyLines(ref) || []).map(line => String(line || '').trim()).filter(Boolean);
    } catch (error) {
      error.ref = ref;
      throw error;
    }
  };

  function getSummaries() {
    const store = readStore();
    const summaries = {};
    for (const [ref, entry] of Object.entries(store.lists || {})) {
      summaries[ref] = {
        ...emptySummary(ref),
        ...(entry && entry.summary ? entry.summary : {}),
        running: running?.ref === ref,
        ref,
      };
    }
    if (running?.ref && !summaries[running.ref]) {
      summaries[running.ref] = { ...emptySummary(running.ref), running: true };
    }
    return summaries;
  }

  function getReport(ref) {
    const wanted = String(ref || '');
    const lines = linesFor(wanted);
    const store = readStore();
    const entry = store.lists[wanted] || { summary: emptySummary(wanted), results: {} };
    const results = entry.results && typeof entry.results === 'object' ? entry.results : {};
    const rows = [];
    let invalid = 0;
    let working = 0;
    let failed = 0;
    let tested = 0;
    const latencies = [];
    for (const raw of lines) {
      const parsed = parseProxyLine(raw);
      const key = lineKey(raw);
      const saved = results[key];
      let status = 'untested';
      let ms = null;
      let error = '';
      let testedAt = 0;
      let bucket = '';
      if (!parsed) {
        status = 'invalid';
        invalid += 1;
        error = 'invalid proxy line';
      } else if (saved && saved.status) {
        status = saved.status;
        ms = Number.isFinite(Number(saved.ms)) ? Number(saved.ms) : null;
        error = String(saved.error || '');
        testedAt = Number(saved.testedAt) || 0;
        bucket = speedBucket(ms);
        if (status === 'working' || status === 'failed') {
          tested += 1;
          if (status === 'working') {
            working += 1;
            if (ms != null) latencies.push(ms);
          } else failed += 1;
        }
        if (status === 'invalid') invalid += 1;
      }
      rows.push({
        key,
        host: displayHost(parsed, raw),
        status,
        ms,
        error,
        testedAt,
        bucket,
      });
    }
    const interesting = rows.filter(row => row.status !== 'untested');
    const visible = rows.length <= ROW_CAP
      ? rows
      : [...interesting, ...rows.filter(row => row.status === 'untested')]
        .slice(0, ROW_CAP);
    const summary = {
      ...emptySummary(wanted),
      ...(entry.summary || {}),
      ref: wanted,
      running: running?.ref === wanted,
      total: lines.length,
      tested,
      working,
      failed,
      invalid,
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
    };
    return {
      ...summary,
      rowCap: ROW_CAP,
      truncated: rows.length > visible.length,
      rows: visible,
    };
  }

  function stop(ref) {
    if (!running) return false;
    if (ref && running.ref !== String(ref)) return false;
    running.cancelled = true;
    try { running.controller?.abort(); } catch {}
    return true;
  }

  async function start({ ref, mode: requestedMode } = {}, onProgress = () => {}) {
    const wanted = String(ref || '').trim();
    if (!wanted) throw new Error('Proxy list is required');
    if (running) throw new Error('A proxy test is already running');

    const lines = linesFor(wanted);
    const parsedLines = lines.map(raw => ({ raw, parsed: parseProxyLine(raw), key: lineKey(raw) }));
    const invalidItems = parsedLines.filter(item => !item.parsed);
    const validItems = parsedLines.filter(item => item.parsed);
    const mode = requestedMode === 'full' || requestedMode === 'sample'
      ? requestedMode
      : (validItems.length <= fullLimit ? 'full' : 'sample');
    const selected = mode === 'sample'
      ? pickSample(validItems, sampleSize, random)
      : validItems;
    const controller = new AbortController();
    running = { ref: wanted, cancelled: false, controller };
    const latencies = [];
    const results = {};
    for (const item of invalidItems) {
      results[item.key] = {
        status: 'invalid',
        ms: null,
        error: 'invalid proxy line',
        host: displayHost(null, item.raw),
        testedAt: now(),
      };
    }

    let tested = 0;
    let working = 0;
    let failed = 0;
    let lastEmit = 0;
    const snapshot = (runningNow, extra = {}) => summarize({
      ref: wanted,
      updatedAt: now(),
      mode,
      running: runningNow,
      total: lines.length,
      sampled: selected.length,
      tested,
      working,
      failed,
      invalid: invalidItems.length,
      latencies,
      ...extra,
    });
    const emit = force => {
      const at = now();
      if (!force && at - lastEmit < 80) return;
      lastEmit = at;
      try { onProgress(snapshot(true)); } catch {}
    };

    emit(true);
    try {
      await mapPool(selected, concurrency, async item => {
        if (running?.cancelled) return;
        const outcome = await probe(item.parsed, {
          url: probeUrl,
          timeoutMs,
          signal: controller.signal,
        });
        const ok = outcome && outcome.ok === true;
        const ms = Number(outcome && outcome.ms);
        if (ok && Number.isFinite(ms)) latencies.push(ms);
        if (ok) working += 1;
        else failed += 1;
        tested += 1;
        results[item.key] = {
          status: ok ? 'working' : 'failed',
          ms: Number.isFinite(ms) ? ms : null,
          error: ok ? '' : String((outcome && outcome.error) || 'failed'),
          host: displayHost(item.parsed, item.raw),
          testedAt: now(),
        };
        emit(false);
      }, () => running?.cancelled === true);

      const summary = snapshot(false);
      if (!running?.cancelled) {
        const store = readStore();
        const previous = store.lists[wanted] && store.lists[wanted].results
          ? store.lists[wanted].results : {};
        const nextResults = mode === 'full' ? { ...results } : { ...previous, ...results };
        const liveKeys = new Set(parsedLines.map(item => item.key));
        for (const key of Object.keys(nextResults)) {
          if (!liveKeys.has(key)) delete nextResults[key];
        }
        store.lists[wanted] = { summary, results: nextResults };
        writeStore(store);
      }
      try { onProgress(snapshot(false)); } catch {}
      return snapshot(false);
    } finally {
      if (running?.ref === wanted) running = null;
    }
  }

  return {
    getSummaries,
    getReport,
    start,
    stop,
    isRunning: () => Boolean(running),
  };
}

module.exports = {
  FULL_TEST_LIMIT,
  SAMPLE_SIZE,
  CONCURRENCY,
  TIMEOUT_MS,
  PROBE_URL,
  parseProxyLine,
  lineKey,
  displayHost,
  speedBucket,
  percentile,
  pickSample,
  resolveMode,
  summarize,
  createProxyTestControl,
};
