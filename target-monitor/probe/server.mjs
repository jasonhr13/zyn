import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { runSuite, REGION_LABELS } from './lib.mjs';

const PORT = Number(process.env.PORT || 8080);
const TOKEN = process.env.PROBE_TOKEN || '';
const MAX_PROXIES = 200;
const MAX_BODY = 1024 * 1024;

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
  });
  res.end(data);
}

function authorized(req) {
  if (!TOKEN) return false;
  const got = String(req.headers.authorization || '');
  const want = `Bearer ${TOKEN}`;
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function info() {
  const region = process.env.FLY_REGION || 'local';
  return {
    ok: true,
    region,
    regionLabel: REGION_LABELS[region] || region,
    machine: process.env.FLY_MACHINE_ID || process.env.FLY_ALLOC_ID || '',
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
      json(res, 200, info());
      return;
    }
    if (req.method === 'POST' && url.pathname === '/run') {
      if (!authorized(req)) {
        json(res, 401, { error: 'unauthorized' });
        return;
      }
      const raw = await readBody(req);
      let body = {};
      if (raw.trim()) {
        try {
          body = JSON.parse(raw);
        } catch {
          json(res, 400, { error: 'invalid json' });
          return;
        }
      }
      const proxies = Array.isArray(body.proxies) ? body.proxies.map((v) => String(v)) : [];
      if (proxies.length > MAX_PROXIES) {
        json(res, 400, { error: `max ${MAX_PROXIES} proxies` });
        return;
      }
      const result = await runSuite({
        proxies,
        rounds: clamp(body.rounds, 1, 3, 1),
        concurrency: clamp(body.concurrency, 1, 25, 12),
        timeoutMs: clamp(body.timeoutMs, 2000, 15000, 8000),
        directCount: clamp(body.directCount, 1, 10, 5),
        tcin: body.tcin ? String(body.tcin) : undefined,
      });
      json(res, 200, result);
      return;
    }
    json(res, 404, { error: 'not found' });
  } catch (err) {
    json(res, err.status || 500, { error: err.message || 'internal error' });
  }
});

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

server.listen(PORT, '0.0.0.0', () => {
  const region = process.env.FLY_REGION || 'local';
  console.log(`redsky probe listening on :${PORT} region=${region}`);
});
