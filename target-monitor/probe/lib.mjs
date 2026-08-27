import net from 'node:net';
import tls from 'node:tls';
import { lookup } from 'node:dns/promises';
import { performance } from 'node:perf_hooks';

export const REDSKY_HOST = 'redsky.target.com';
export const REDSKY_PORT = 443;
export const DEFAULT_KEY = '9f36aeafbe60771e321a7cc95a78140772ab3e96';
export const DEFAULT_TCIN = '88897904';
export const DEFAULT_STORE = '875';

export const REGION_LABELS = {
  iad: 'Ashburn, VA',
  dfw: 'Dallas, TX',
  ord: 'Chicago, IL',
};

const APP_HEADERS = [
  'accept: */*',
  'accept-language: en-US,en;q=0.9',
  'accept-encoding: identity',
  'x-channel-id: APPS',
  'x-client-platform: iPhone',
  'x-client-version: 2026.28.0',
  'user-agent: Target/2026.28.0 iPhone15,2 iOS/26.4.1 CFNetwork/3860.500.112 Darwin/25.4.0',
  'connection: close',
];

export function redskyPath({ key = DEFAULT_KEY, storeId = DEFAULT_STORE, tcin = DEFAULT_TCIN } = {}) {
  const q = new URLSearchParams({
    key,
    pricing_store_id: storeId,
    store_id: storeId,
    tcins: tcin,
  });
  return `/redsky_aggregations/v1/apps/tcin_product_list_v2?${q}`;
}

export function parseProxyLine(raw) {
  const value = String(raw || '').trim();
  if (!value || value.startsWith('#')) return null;

  if (value.includes('://')) {
    let url;
    try {
      url = new URL(value);
    } catch {
      return null;
    }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) return null;
    const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return {
      url: url.toString(),
      protocol: url.protocol,
      hostname: url.hostname,
      port,
      username: decodeSafe(url.username),
      password: decodeSafe(url.password),
      label: `${url.hostname}:${port}`,
    };
  }

  const ipv6 = value.match(/^\[([^\]]+)\]:(\d+)(?::([^:]*)(?::(.*))?)?$/);
  if (ipv6) {
    const port = Number(ipv6[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    const username = ipv6[3] || '';
    const password = ipv6[4] || '';
    const auth = username ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : '';
    return {
      url: `http://${auth}[${ipv6[1]}]:${port}`,
      protocol: 'http:',
      hostname: ipv6[1],
      port,
      username,
      password,
      label: `[${ipv6[1]}]:${port}`,
    };
  }

  if (value.includes('@') && !value.includes('://')) {
    try {
      return parseProxyLine(`http://${value}`);
    } catch {
      return null;
    }
  }

  const parts = value.split(':');
  const host = parts.shift() || '';
  const port = Number(parts.shift() || '');
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  const username = parts.shift() || '';
  const password = parts.join(':');
  const auth = username ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : '';
  return {
    url: `http://${auth}${host}:${port}`,
    protocol: 'http:',
    hostname: host,
    port,
    username,
    password,
    label: `${host}:${port}`,
  };
}

function decodeSafe(value) {
  if (!value) return '';
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function round(ms) {
  return Math.round(ms * 10) / 10;
}

function destroySoon(socket) {
  try {
    socket.destroy();
  } catch {
    /* ignore */
  }
}

function connectTcp(host, port, timeoutMs, start = performance.now()) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port, noDelay: true });
    const timer = setTimeout(() => {
      destroySoon(socket);
      reject(Object.assign(new Error(`tcp timeout after ${timeoutMs}ms`), { code: 'TIMEOUT' }));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve({ socket, tcpMs: round(performance.now() - start) });
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      destroySoon(socket);
      reject(err);
    });
  });
}

function wrapTls(socket, servername, timeoutMs, start) {
  return new Promise((resolve, reject) => {
    const tlsSocket = tls.connect({
      socket,
      servername,
      ALPNProtocols: ['http/1.1'],
    });
    const timer = setTimeout(() => {
      destroySoon(tlsSocket);
      reject(Object.assign(new Error(`tls timeout after ${timeoutMs}ms`), { code: 'TIMEOUT' }));
    }, timeoutMs);
    tlsSocket.once('secureConnect', () => {
      clearTimeout(timer);
      resolve({ tlsSocket, tlsMs: round(performance.now() - start) });
    });
    tlsSocket.once('error', (err) => {
      clearTimeout(timer);
      destroySoon(tlsSocket);
      reject(err);
    });
  });
}

function readHttpMessage(socket, timeoutMs, start) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let ttfbMs = null;
    const timer = setTimeout(() => {
      cleanup();
      reject(Object.assign(new Error(`http timeout after ${timeoutMs}ms`), { code: 'TIMEOUT' }));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('end', onEnd);
    }

    function fail(err) {
      cleanup();
      reject(err);
    }

    function tryParse() {
      const buf = Buffer.concat(chunks);
      const headerEnd = buf.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const head = buf.subarray(0, headerEnd).toString('latin1');
      const body = buf.subarray(headerEnd + 4);
      const lines = head.split('\r\n');
      const statusLine = lines[0] || '';
      const statusMatch = statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/);
      if (!statusMatch) {
        fail(new Error(`bad status line: ${statusLine.slice(0, 80)}`));
        return;
      }
      const status = Number(statusMatch[1]);
      const headers = {};
      for (const line of lines.slice(1)) {
        const idx = line.indexOf(':');
        if (idx === -1) continue;
        headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
      }
      const lower = headers['content-type'] || '';
      const contentLength = headers['content-length'] != null ? Number(headers['content-length']) : null;
      const chunked = (headers['transfer-encoding'] || '').toLowerCase().includes('chunked');

      if (contentLength != null && Number.isFinite(contentLength)) {
        if (body.length < contentLength) return;
        finish(status, headers, body.subarray(0, contentLength), lower);
        return;
      }
      if (chunked) {
        const decoded = decodeChunked(body);
        if (!decoded) return;
        finish(status, headers, decoded, lower);
        return;
      }
      // connection: close — wait for end
    }

    function finish(status, headers, body, contentType) {
      cleanup();
      const text = body.toString('utf8');
      resolve({
        status,
        ttfbMs: round(ttfbMs ?? (performance.now() - start)),
        totalMs: round(performance.now() - start),
        bytes: body.length,
        captcha: status === 403 && /captcha/i.test(text),
        json: contentType.includes('json') || text.trimStart().startsWith('{'),
      });
    }

    function onData(chunk) {
      if (ttfbMs == null) ttfbMs = performance.now() - start;
      chunks.push(chunk);
      try {
        tryParse();
      } catch (err) {
        fail(err);
      }
    }

    function onError(err) {
      fail(err);
    }

    function onEnd() {
      const buf = Buffer.concat(chunks);
      const headerEnd = buf.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        fail(new Error('socket ended before HTTP headers'));
        return;
      }
      const head = buf.subarray(0, headerEnd).toString('latin1');
      const body = buf.subarray(headerEnd + 4);
      const statusMatch = (head.split('\r\n')[0] || '').match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/);
      const status = statusMatch ? Number(statusMatch[1]) : 0;
      cleanup();
      const text = body.toString('utf8');
      resolve({
        status,
        ttfbMs: round(ttfbMs ?? (performance.now() - start)),
        totalMs: round(performance.now() - start),
        bytes: body.length,
        captcha: status === 403 && /captcha/i.test(text),
        json: text.trimStart().startsWith('{'),
      });
    }

    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('end', onEnd);
  });
}

function decodeChunked(buf) {
  let offset = 0;
  const out = [];
  while (offset < buf.length) {
    const lineEnd = buf.indexOf('\r\n', offset);
    if (lineEnd === -1) return null;
    const size = Number.parseInt(buf.subarray(offset, lineEnd).toString('ascii'), 16);
    if (!Number.isFinite(size)) return null;
    offset = lineEnd + 2;
    if (size === 0) return Buffer.concat(out);
    if (offset + size + 2 > buf.length) return null;
    out.push(buf.subarray(offset, offset + size));
    offset += size + 2;
  }
  return null;
}

async function httpConnect(socket, host, port, proxy, timeoutMs, start) {
  const auth = proxy.username
    ? Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')
    : null;
  const req = [
    `CONNECT ${host}:${port} HTTP/1.1`,
    `host: ${host}:${port}`,
    auth ? `proxy-authorization: Basic ${auth}` : null,
    'proxy-connection: keep-alive',
    '',
    '',
  ].filter((line) => line !== null).join('\r\n');

  socket.write(req);

  const { head } = await readUntil(socket, Buffer.from('\r\n\r\n'), timeoutMs);
  const statusMatch = head.toString('latin1').match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/);
  const status = statusMatch ? Number(statusMatch[1]) : 0;
  if (status !== 200) {
    throw Object.assign(new Error(`proxy CONNECT ${status || 'failed'}`), { code: 'CONNECT', status });
  }
  return round(performance.now() - start);
}

function readUntil(socket, needle, timeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const timer = setTimeout(() => {
      cleanup();
      reject(Object.assign(new Error('CONNECT response timeout'), { code: 'TIMEOUT' }));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('end', onEnd);
    }

    function onData(chunk) {
      chunks.push(chunk);
      const data = Buffer.concat(chunks);
      const idx = data.indexOf(needle);
      if (idx === -1) return;
      cleanup();
      const rest = data.subarray(idx + needle.length);
      if (rest.length) socket.unshift(rest);
      resolve({ head: data.subarray(0, idx + needle.length) });
    }

    function onError(err) {
      cleanup();
      reject(err);
    }

    function onEnd() {
      cleanup();
      reject(new Error('proxy closed during CONNECT'));
    }

    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('end', onEnd);
  });
}

function writeGet(socket, host, path) {
  socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\n${APP_HEADERS.join('\r\n')}\r\n\r\n`);
}

export async function probeDirect({ timeoutMs = 8000, path = redskyPath() } = {}) {
  const start = performance.now();
  let socket;
  let tlsSocket;
  const result = { ok: false, via: 'direct', host: REDSKY_HOST };
  try {
    const dnsStart = performance.now();
    const dns = await lookup(REDSKY_HOST, { family: 4 });
    result.dnsMs = round(performance.now() - dnsStart);
    result.ip = dns.address;

    const tcp = await connectTcp(dns.address, REDSKY_PORT, timeoutMs, start);
    socket = tcp.socket;
    result.tcpMs = tcp.tcpMs;

    const tlsRes = await wrapTls(socket, REDSKY_HOST, timeoutMs, start);
    tlsSocket = tlsRes.tlsSocket;
    result.tlsMs = tlsRes.tlsMs;

    writeGet(tlsSocket, REDSKY_HOST, path);
    const http = await readHttpMessage(tlsSocket, timeoutMs, start);
    Object.assign(result, http);
    result.ok = http.status >= 200 && http.status < 400 && !http.captcha;
    return result;
  } catch (err) {
    result.error = err.code || err.message;
    result.totalMs = round(performance.now() - start);
    return result;
  } finally {
    destroySoon(tlsSocket || socket);
  }
}

export async function probeViaProxy(proxy, { timeoutMs = 8000, path = redskyPath() } = {}) {
  const start = performance.now();
  let socket;
  let tlsSocket;
  const result = { ok: false, via: 'proxy', proxy: proxy.label };
  try {
    const dnsStart = performance.now();
    const dns = await lookup(proxy.hostname, { family: 4 });
    result.dnsMs = round(performance.now() - dnsStart);
    result.proxyIp = dns.address;

    const tcp = await connectTcp(dns.address, proxy.port, timeoutMs, start);
    socket = tcp.socket;
    result.tcpMs = tcp.tcpMs;

    let tunnel = socket;
    if (proxy.protocol === 'https:') {
      const proxyTls = await wrapTls(socket, proxy.hostname, timeoutMs, start);
      tunnel = proxyTls.tlsSocket;
    }

    result.connectMs = await httpConnect(tunnel, REDSKY_HOST, REDSKY_PORT, proxy, timeoutMs, start);

    const tlsRes = await wrapTls(tunnel, REDSKY_HOST, timeoutMs, start);
    tlsSocket = tlsRes.tlsSocket;
    result.tlsMs = tlsRes.tlsMs;

    writeGet(tlsSocket, REDSKY_HOST, path);
    const http = await readHttpMessage(tlsSocket, timeoutMs, start);
    Object.assign(result, http);
    result.ok = http.status >= 200 && http.status < 400 && !http.captcha;
    return result;
  } catch (err) {
    result.error = err.code || err.message;
    result.totalMs = round(performance.now() - start);
    return result;
  } finally {
    destroySoon(tlsSocket || socket);
  }
}

export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function stats(values) {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  return {
    n: nums.length,
    min: nums.length ? Math.min(...nums) : null,
    p50: percentile(nums, 50),
    p90: percentile(nums, 90),
    p99: percentile(nums, 99),
    max: nums.length ? Math.max(...nums) : null,
    mean: nums.length ? round(nums.reduce((a, b) => a + b, 0) / nums.length) : null,
  };
}

export function summarize(samples) {
  const ok = samples.filter((s) => s.ok);
  const statuses = {};
  const errors = {};
  for (const s of samples) {
    const key = s.captcha ? 'captcha' : s.status != null ? String(s.status) : s.error || 'error';
    statuses[key] = (statuses[key] || 0) + 1;
    if (!s.ok) errors[s.error || `http_${s.status}`] = (errors[s.error || `http_${s.status}`] || 0) + 1;
  }
  return {
    count: samples.length,
    ok: ok.length,
    fail: samples.length - ok.length,
    okRate: samples.length ? round((ok.length / samples.length) * 100) : 0,
    statuses,
    errors,
    tcpMs: stats(ok.map((s) => s.tcpMs)),
    connectMs: stats(ok.map((s) => s.connectMs).filter((v) => v != null)),
    tlsMs: stats(ok.map((s) => s.tlsMs)),
    ttfbMs: stats(ok.map((s) => s.ttfbMs)),
    totalMs: stats(ok.map((s) => s.totalMs)),
  };
}

export async function runSuite({
  proxies = [],
  rounds = 1,
  concurrency = 12,
  timeoutMs = 8000,
  directCount = 5,
  tcin = DEFAULT_TCIN,
  storeId = DEFAULT_STORE,
  key = DEFAULT_KEY,
} = {}) {
  const path = redskyPath({ key, storeId, tcin });
  const region = process.env.FLY_REGION || 'local';
  const machine = process.env.FLY_MACHINE_ID || process.env.FLY_ALLOC_ID || '';
  const parsed = [];
  const skipped = [];
  for (const line of proxies) {
    const proxy = parseProxyLine(line);
    if (proxy) parsed.push(proxy);
    else if (String(line || '').trim()) skipped.push(String(line).trim().slice(0, 40));
  }

  const direct = [];
  for (let i = 0; i < directCount; i++) {
    direct.push(await probeDirect({ timeoutMs, path }));
  }

  const jobs = [];
  for (let round = 1; round <= rounds; round++) {
    for (const proxy of parsed) jobs.push({ proxy, round });
  }
  const proxySamples = await mapLimit(jobs, concurrency, ({ proxy, round }) =>
    probeViaProxy(proxy, { timeoutMs, path }).then((sample) => ({ ...sample, round })),
  );

  return {
    at: new Date().toISOString(),
    region,
    regionLabel: REGION_LABELS[region] || region,
    machine,
    target: { host: REDSKY_HOST, tcin, storeId },
    skipped: skipped.length,
    direct: {
      samples: direct,
      summary: summarize(direct),
    },
    proxies: {
      submitted: proxies.length,
      parsed: parsed.length,
      rounds,
      samples: proxySamples,
      summary: summarize(proxySamples),
    },
  };
}
