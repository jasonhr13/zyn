'use strict';

const crypto = require('crypto');
const http = require('http');

function applyDemand(input = {}) {
  const activeTasks = Math.max(0, Math.floor(Number(input.activeTasks) || 0));
  const standbyTasks = Math.max(0, Math.floor(Number(input.standbyTasks) || 0));
  const atcPerTask = Math.max(0, Math.floor(Number(input.atcPerTask) || 0));
  const basis = String(input.basis || (activeTasks ? 'active' : standbyTasks ? 'standby' : 'paused'));
  const effective = basis === 'paused' ? 0 : basis === 'standby' ? standbyTasks : activeTasks;
  const explicit = input.targets && typeof input.targets === 'object' ? input.targets : null;
  const login = explicit && Object.prototype.hasOwnProperty.call(explicit, 'login')
    ? (explicit.login == null ? null : Math.max(0, Math.floor(Number(explicit.login) || 0)))
    : effective;
  const atc = explicit && Object.prototype.hasOwnProperty.call(explicit, 'atc')
    ? (explicit.atc == null ? null : Math.max(0, Math.floor(Number(explicit.atc) || 0)))
    : (atcPerTask > 0 ? effective * atcPerTask : effective);
  const demand = {
    mode: 'per-task',
    basis,
    activeTasks,
    standbyTasks,
    effectiveTasks: effective,
    atcPerTask,
    targets: { login, atc },
  };
  return { demand, targets: { login, atc } };
}

function tokenOk(req, token) {
  if (!token) return true;
  const sent = Buffer.from(String(req.headers['x-zyn-token'] || ''), 'utf8');
  const want = Buffer.from(token, 'utf8');
  return sent.length === want.length && crypto.timingSafeEqual(sent, want);
}

function createCookieBank({ token = '', port = 4727, ttlMs = 10 * 60 * 1000, host = '127.0.0.1' } = {}) {
  const pool = { login: [], atc: [] };
  const waiters = { login: [], atc: [] };
  let demand = applyDemand({ activeTasks: 0, standbyTasks: 0, atcPerTask: 0, basis: 'paused' });
  const producers = new Map();

  const prune = type => {
    const now = Date.now();
    pool[type] = pool[type].filter(cookie => Number(cookie.expiresAt) > now);
  };

  const pushCookie = (type, headers, proxy, extra = {}) => {
    const cookie = {
      type,
      headers: headers && typeof headers === 'object' ? headers : {},
      proxy: String(proxy || ''),
      source: extra.source || 'remote',
      harvesterId: extra.harvesterId || '',
      createdAt: Date.now(),
      expiresAt: Number(extra.expiresAt) > Date.now() ? Number(extra.expiresAt) : Date.now() + ttlMs,
    };
    if (!Object.keys(cookie.headers).length) return false;
    prune(type);
    const waiter = waiters[type].shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(cookie);
      return true;
    }
    pool[type].push(cookie);
    return true;
  };

  const takeCookie = (type, timeoutMs = 0) => {
    prune(type);
    if (pool[type].length) return Promise.resolve(pool[type].shift());
    if (!timeoutMs) return Promise.resolve(null);
    return new Promise(resolve => {
      const waiter = { resolve, timer: null };
      waiter.timer = setTimeout(() => {
        waiters[type] = waiters[type].filter(item => item !== waiter);
        resolve(null);
      }, timeoutMs);
      waiters[type].push(waiter);
    });
  };

  const readBody = (req, limit) => new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > limit) {
        req.destroy();
        reject(new Error('body too large'));
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });

  const json = (res, obj, code = 200) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${host}:${port}`);
    try {
      if (req.method === 'GET' && url.pathname === '/cookie') {
        if (!tokenOk(req, token)) return json(res, { ok: false, error: 'unauthorized' }, 401);
        const type = url.searchParams.get('type') === 'atc' ? 'atc' : 'login';
        const timeout = url.searchParams.get('wait') === '1'
          ? parseInt(url.searchParams.get('timeout') || '0', 10) : 0;
        const cookie = await takeCookie(type, timeout);
        if (!cookie) return json(res, { ok: false, cookie: { headers: {}, proxy: '' } });
        return json(res, {
          ok: true,
          cookie: {
            type: cookie.type,
            source: cookie.source,
            headers: cookie.headers,
            proxy: cookie.proxy,
            expiresAt: cookie.expiresAt,
            harvesterId: cookie.harvesterId || '',
          },
        });
      }
      if (req.method === 'POST' && url.pathname === '/saveCookies') {
        if (!tokenOk(req, token)) return json(res, { ok: false, error: 'unauthorized' }, 401);
        const data = JSON.parse((await readBody(req, 1e6)) || '{}');
        const items = Array.isArray(data) ? data : [data];
        let saved = 0;
        for (const item of items) {
          const type = (item.type || 'login').toLowerCase() === 'atc' ? 'atc' : 'login';
          if (pushCookie(type, item.headers, item.proxy, item)) saved += 1;
        }
        return json(res, { ok: true, saved });
      }
      if (req.method === 'POST' && url.pathname === '/demand') {
        if (!tokenOk(req, token)) return json(res, { ok: false, error: 'unauthorized' }, 401);
        demand = applyDemand(JSON.parse((await readBody(req, 64000)) || '{}'));
        return json(res, { ok: true, demand: demand.demand });
      }
      if (req.method === 'POST' && url.pathname === '/harvesterStatus') {
        if (!tokenOk(req, token)) return json(res, { ok: false, error: 'unauthorized' }, 401);
        const data = JSON.parse((await readBody(req, 256000)) || '{}');
        const id = String(data.id || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 64);
        if (!id) return json(res, { ok: false, error: 'missing harvester id' }, 400);
        producers.set(id, { ...data, id, seenAt: Date.now() });
        return json(res, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/session-ready') {
        if (!tokenOk(req, token)) return json(res, { ok: false, error: 'unauthorized' }, 401);
        return json(res, { ok: true, sessionReady: true });
      }
      if (req.method === 'GET' && url.pathname === '/status') {
        prune('login');
        prune('atc');
        return json(res, {
          ok: true,
          pid: process.pid,
          login: pool.login.length,
          atc: pool.atc.length,
          pools: { login: pool.login.length, atc: pool.atc.length },
          activity: { waiting: { login: waiters.login.length, atc: waiters.atc.length } },
          demand: demand.demand,
          targets: demand.targets,
          producers: [...producers.values()].map(item => ({
            id: item.id,
            name: item.name,
            produced: item.produced,
            seenAt: item.seenAt,
          })),
        });
      }
      json(res, { ok: false, error: 'not found' }, 404);
    } catch (error) {
      json(res, { ok: false, error: error.message }, 400);
    }
  });

  return {
    port,
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => resolve(server.address()));
    }),
    close: () => new Promise(resolve => server.close(() => resolve())),
    saveCookie: (type, headers, proxy, extra) => pushCookie(type === 'atc' ? 'atc' : 'login', headers, proxy, extra),
    snapshot: () => {
      prune('login');
      prune('atc');
      return {
        login: pool.login.length,
        atc: pool.atc.length,
        waiting: { login: waiters.login.length, atc: waiters.atc.length },
        demand: demand.demand,
      };
    },
  };
}

module.exports = { createCookieBank, applyDemand };
