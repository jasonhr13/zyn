'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const { FILES } = require('./data-store');
const { sendConfigsPayload, targetStartMessages, pokemonStartMessages } = require('./configs');
const { decodeCookie } = require('./secrets');
const workspace = require('./workspace');
const { createIpcRouter } = require('./ipc');
const PUBLIC_API = new Set([
  '/api/auth/login',
  '/api/auth/reset',
  '/api/auth/session',
  '/api/ipc/sync',
  '/api/ipc/invoke',
  '/api/ipc/send',
]);

const PUBLIC = path.join(__dirname, 'public');
const BLOCKED_FILES = new Set(['license-session.json', 'session-kind.json', 'device-id.json', 'web-session.json']);
const ALLOWED_FILES = new Set(Object.values(FILES).filter(name => !BLOCKED_FILES.has(name)));
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function bearerToken(req) {
  const header = String(req.headers.authorization || '');
  if (header.startsWith('Bearer ')) return header.slice(7);
  return new URL(req.url, 'http://127.0.0.1').searchParams.get('token') || '';
}

function tokenMatches(req, webToken) {
  if (!webToken) return true;
  const sent = Buffer.from(bearerToken(req), 'utf8');
  const want = Buffer.from(webToken, 'utf8');
  return sent.length === want.length && crypto.timingSafeEqual(sent, want);
}

function authorize(req, { webToken, sessions, license } = {}) {
  if (!tokenMatches(req, webToken)) return false;
  if (!license || !sessions) return !webToken;
  return license.status().ok === true && sessions.fromRequest(req);
}

function loginStatusText(status) {
  if (status == null) return '';
  if (typeof status === 'string') return status;
  return [status.state, status.label, status.detail].filter(Boolean).join(' ');
}

function loginStatusNeedsHarvester(status) {
  return /\b(?:getting session|logging in|\blogin\b|requesting login code|waiting for code|submitting code|validating login|waiting for shape)\b/i
    .test(loginStatusText(status));
}

function loginStatusClearsHarvester(status) {
  return /\b(?:waiting for restock|watching for restock|getting product(?:s|\(s\))?|monitoring products?|adding to cart|carted|submitting payment|submitting cvv|submitting order|successful|checked out|out of stock|waiting for order)\b/i
    .test(loginStatusText(status));
}

function cookieOpts(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '');
  return { secure: proto === 'https' || (process.env.NODE_ENV === 'production' && proto !== 'http') };
}

function webEngineDemand(active, atcPerTask, loginTasks = 0) {
  const count = Math.max(0, Math.floor(Number(active) || 0));
  const perTask = Math.max(0, Math.floor(Number(atcPerTask) || 0));
  const needed = Math.max(0, Math.floor(Number(loginTasks) || 0));
  // Login Shape takes longer to mint than GetShape waits, and ATC-only remote
  // harvesters never produce login cookies. Prefarm a small login bank whenever
  // checkout is live; stay at 0 when paused.
  const login = count ? Math.max(needed, 2) : 0;
  return {
    activeTasks: count,
    standbyTasks: 0,
    atcPerTask: perTask,
    basis: count ? 'active' : 'paused',
    loginTasks: login,
    targets: {
      login,
      atc: count ? count * perTask : 0,
    },
  };
}

function resolveUiRoot() {
  const candidates = [
    path.join(__dirname, '..', 'ui'),
    path.join(__dirname, '../../frontend/build'),
  ];
  return candidates.find(dir => fs.existsSync(path.join(dir, 'index.html'))) || '';
}

function sendJson(res, obj, code = 200) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req, limit = 2e6) {
  return new Promise((resolve, reject) => {
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
}

function createHttpServer({
  store,
  engine,
  bank,
  webToken,
  license,
  sessions,
  harvest,
  backup,
  otp,
  onDemand = () => {},
} = {}) {
  const clients = new Set();
  const running = { target: new Set(), pokemon: new Set(), monitors: new Set() };
  const loginNeedIds = new Set();
  let lastHarvestWarnAt = 0;
  let lastHarvestWarnKey = '';

  const isTargetMonitorId = id => running.monitors.has(id) || /^zyn-web-/.test(String(id || ''));

  const startTargetMonitor = spec => {
    const id = String(spec && spec.id || 'zyn-web-target');
    running.monitors.add(id);
    engine.send({
      type: 'start-monitors',
      messages: [{ ...spec, id }],
    });
    return id;
  };

  const stopTargetMonitors = () => {
    const ids = [...running.monitors];
    running.monitors.clear();
    if (ids.length) engine.send({ type: 'stop-tasks', messages: ids.map(id => ({ id })) });
    return ids;
  };

  const broadcast = payload => {
    const text = JSON.stringify(payload);
    for (const client of clients) {
      if (client.readyState === 1) client.send(text);
    }
  };
  const emit = (channel, payload) => broadcast({ channel, payload });

  const noteLoginNeed = (taskId, needed) => {
    const id = String(taskId || '');
    if (!id) return;
    if (needed) loginNeedIds.add(id);
    else loginNeedIds.delete(id);
  };

  const handleEngineMessage = envelope => {
    broadcast({ source: 'engine', ...envelope });
    if (envelope.type === 'update-status') {
      const updates = [];
      for (const message of envelope.messages || []) {
        if (!message || !message.status) continue;
        const taskId = String(message.taskID || message.taskId || message.id || '');
        const update = {
          taskId,
          state: message.status,
          label: message.status,
          color: message.color || '',
          detail: message.detail || '',
          taskState: message.state,
          running: message.running,
        };
        if (isTargetMonitorId(taskId)) {
          if (message.running === false) running.monitors.delete(taskId);
          continue;
        }
        updates.push(update);
        if (taskId && running.target.has(taskId)) {
          if (message.running === false || loginStatusClearsHarvester(message.status)) {
            noteLoginNeed(taskId, false);
          } else if (loginStatusNeedsHarvester(message.status)) {
            noteLoginNeed(taskId, true);
          }
          if (message.running === false) {
            running.target.delete(taskId);
            emit('targetDone', { taskId });
            if (!running.target.size) stopTargetMonitors();
          }
        }
        if (taskId && running.pokemon.has(taskId) && message.running === false) {
          running.pokemon.delete(taskId);
          emit('pokemonDone', { taskId });
        }
      }
      if (updates.length) {
        emit('targetStatusBatch', { updates });
        for (const update of updates) emit('targetStatus', update);
        publishBankDemand();
      }
    }
    if (envelope.type === 'task-log') {
      for (const message of envelope.messages || []) {
        const line = message && (message.data || message.line || message.status);
        if (!line) continue;
        emit('targetLog', { line: String(line), taskId: message.taskID || message.taskId || '' });
      }
    }
    if (envelope.type === 'request-code' && otp) {
      for (const message of envelope.messages || []) {
        const email = message && message.email || '';
        const taskId = message && (message.taskID || message.taskId) || '';
        emit('targetLog', {
          line: `[otp] verification code needed for ${email} — checking mailbox, or enter it above`,
          taskId,
        });
        otp.handleRequest(message);
      }
    }
    if (envelope.type === 'account-cookie') {
      for (const message of envelope.messages || []) {
        if (message && message.accountId && typeof message.cookie === 'string') {
          const accounts = store.getAccountsRaw();
          const account = accounts.find(row => String(row.id) === String(message.accountId));
          if (account) {
            account.cookie = message.cookie;
            store.saveAccounts(accounts);
            noteLoginNeed(message.taskID || message.taskId, false);
          }
        }
      }
      emit('accountsUpdated', store.getAccountsRaw().map(workspace.publicAccount));
      publishBankDemand();
    }
    if (envelope.type === 'monitor-bandwidth') {
      emit('targetMonitorBandwidth', envelope.messages && envelope.messages[0] || envelope);
    }
  };
  engine.subscribe(handleEngineMessage);
  const lastOtpLog = new Map();
  if (otp && typeof otp.subscribe === 'function') {
    otp.subscribe(snapshot => {
      broadcast({ source: 'otp', ...snapshot });
      emit('targetOtp', snapshot);
      for (const item of snapshot.pending || []) {
        if (!item || !item.message) continue;
        const key = String(item.email || item.taskId || '');
        const line = `[otp] ${item.message}`;
        if (lastOtpLog.get(key) === line) continue;
        lastOtpLog.set(key, line);
        emit('targetLog', { line, taskId: item.taskId || '' });
      }
    });
  }

  const publishBankDemand = async () => {
    const demand = webEngineDemand(
      running.target.size,
      Number(store.getSettings().targetAtcCookiesPerTask) || 3,
      loginNeedIds.size,
    );
    await onDemand(demand);
    if (harvest && typeof harvest.update === 'function') {
      try { harvest.update(); } catch {}
    }
    const host = harvest && typeof harvest.snapshot === 'function' ? harvest.snapshot() : {};
    console.log(
      `[harvest] demand login=${demand.targets.login} atc=${demand.targets.atc}`
      + ` running=${running.target.size} need=${loginNeedIds.size}`
      + ` bank=${bank && bank.snapshot ? `${bank.snapshot().login}/${bank.snapshot().atc}` : '?'}`
      + ` companions=${Math.max(0, Number(host.companionCount) || 0)}`,
    );
    const loginWanted = Number(demand.targets && demand.targets.login) || 0;
    if (loginWanted > 0 && harvest && typeof harvest.snapshot === 'function') {
      const host = harvest.snapshot() || {};
      const bankSnap = bank && typeof bank.snapshot === 'function' ? bank.snapshot() : {};
      const companions = Math.max(0, Number(host.companionCount) || 0);
      let line = '';
      if (host.connected !== true) {
        line = '[harvest] Full Engine is not connected to the harvest room, so login cookies cannot arrive from the Mac.';
      } else if (companions < 1) {
        line = '[harvest] no harvest-only Mac in the room — sign the QA app in as Harvester only on this same Zyn account.';
      } else if (!(Number(bankSnap.login) > 0)) {
        line = `[harvest] ${companions} harvest-only app(s) connected; waiting for a login Shape cookie (ATC ${Number(bankSnap.atc) || 0} already in bank).`;
      }
      const now = Date.now();
      if (line && (line !== lastHarvestWarnKey || now - lastHarvestWarnAt > 15000)) {
        lastHarvestWarnKey = line;
        lastHarvestWarnAt = now;
        emit('targetLog', { line });
      }
    }
  };

  const startTargetGroup = async groupId => {
    const groups = store.taskGroups.load();
    const group = groups.find(item => item.id === groupId);
    if (!group) throw new Error('unknown Target group');
    const messages = targetStartMessages(group, store);
    if (!messages.length) throw new Error('group has no tasks');
    await engine.ready();
    const configs = sendConfigsPayload(store, group.tasks);
    if (!engine.send({ type: 'send-configs', messages: [configs] })) {
      throw new Error('engine is not connected');
    }
    if (!engine.send({ type: 'start-tasks', messages })) throw new Error('start-tasks failed');
    startTargetMonitor({
      id: `zyn-web-${group.id}`,
      site: 'Target',
      proxyGroup: messages[0].proxyGroup,
      monitorDelay: '4000',
      items: (group.items || []).map(item => ({
        monitorInput: item.sku,
        quantity: String(group.qty || 2),
        maxPrice: item.maxPrice || '',
      })),
    });
    for (const task of messages) {
      running.target.add(task.id);
      const account = store.getAccountsRaw().find(row => String(row.id) === String(task.accountId));
      noteLoginNeed(task.id, !decodeCookie(account && account.cookie));
    }
    emit('targetRunStarted', { taskIds: messages.map(task => task.id), startedAt: Date.now() });
    await publishBankDemand();
    return { started: messages.map(task => task.id) };
  };

  const startTarget = async (config = {}) => {
    if (config && config.id && !config.tasks) return startTargetGroup(config.id);
    const tasks = Array.isArray(config.tasks) ? config.tasks : [];
    const items = Array.isArray(config.items) && config.items.length
      ? config.items
      : (Array.isArray(config.skus) ? config.skus.map(sku => ({ sku })) : []);
    const group = {
      items,
      qty: config.qty,
      useFillerItem: config.useFillerItem === true,
      stockConfidence: config.stockConfidence,
      proxyListName: config.proxyListName || (tasks[0] && tasks[0].proxyListName) || '',
      tasks,
    };
    const messages = targetStartMessages(group, store);
    if (!messages.length) throw new Error('group has no tasks');
    const failStart = (error) => {
      for (const task of messages) {
        emit('targetStatus', {
          taskId: task.id,
          state: error.message || 'Start failed',
          label: error.message || 'Start failed',
          color: '#ff7b83',
          running: false,
        });
        emit('targetDone', { taskId: task.id });
        emit('targetLog', { line: `[target] ${error.message}`, taskId: task.id });
      }
      throw error;
    };
    try {
      await engine.ready();
    } catch (error) {
      failStart(error);
    }
    const configs = sendConfigsPayload(store, tasks);
    if (!engine.send({ type: 'send-configs', messages: [configs] })) {
      failStart(new Error('engine is not connected'));
    }
    if (!engine.send({ type: 'start-tasks', messages })) failStart(new Error('start-tasks failed'));
    startTargetMonitor({
      id: 'zyn-web-target',
      site: 'Target',
      proxyGroup: messages[0].proxyGroup,
      monitorDelay: '4000',
      items: items.map(item => ({
        monitorInput: item.sku || item.monitorInput || item,
        quantity: String(group.qty || 2),
        maxPrice: item.maxPrice || '',
      })),
    });
    for (const task of messages) {
      running.target.add(task.id);
      const account = store.getAccountsRaw().find(row => String(row.id) === String(task.accountId));
      noteLoginNeed(task.id, !decodeCookie(account && account.cookie));
    }
    emit('targetRunStarted', { taskIds: messages.map(task => task.id), startedAt: Date.now() });
    await publishBankDemand();
    return { started: messages.map(task => task.id) };
  };

  const startPokemon = async () => {
    const state = store.getPokemonCenterTasks();
    const messages = pokemonStartMessages(state);
    if (!messages.length) throw new Error('no Pokémon Center tasks with a profile');
    await engine.ready();
    const configs = sendConfigsPayload(store, messages.map(task => ({
      profileId: task.profileId,
      accountId: '',
      proxyListName: task.proxyGroup === 'Local' ? '' : task.proxyGroup,
    })));
    if (!engine.send({ type: 'send-configs', messages: [configs] })) {
      throw new Error('engine is not connected');
    }
    if (!engine.send({ type: 'start-tasks', messages })) throw new Error('start-tasks failed');
    for (const task of messages) running.pokemon.add(task.id);
    return { started: messages.map(task => task.id) };
  };

  const stopTarget = ids => {
    const stopAll = ids == null;
    const targets = stopAll
      ? [...running.target]
      : (Array.isArray(ids) ? ids : [ids]).map(String).filter(Boolean);
    if (targets.length) engine.send({ type: 'stop-tasks', messages: targets.map(id => ({ id })) });
    for (const id of targets) {
      running.target.delete(id);
      loginNeedIds.delete(id);
      emit('targetStatus', {
        taskId: id,
        state: 'Stopped',
        label: 'Stopped',
        color: '#6b7280',
        running: false,
      });
      emit('targetDone', { taskId: id });
    }
    const monitors = (stopAll || !running.target.size) ? stopTargetMonitors() : [];
    if (!running.target.size && otp && typeof otp.cancelAll === 'function') otp.cancelAll('Target run stopped');
    publishBankDemand();
    return { stopped: targets, monitors };
  };

  const setTaskProxy = (id, proxyListName) => {
    const groups = store.taskGroups.load();
    let changed = false;
    let task = null;
    for (const group of groups) {
      for (const row of group.tasks || []) {
        if (String(row.id) === String(id)) {
          row.proxyListName = proxyListName;
          task = row;
          changed = true;
        }
      }
    }
    if (changed) store.taskGroups.save(groups);
    if (!running.target.has(String(id))) return changed;
    const configs = sendConfigsPayload(store, [{ proxyListName, profileId: task && task.profileId, accountId: task && task.accountId }]);
    engine.send({ type: 'send-configs', messages: [configs] });
    const { displayProxyGroup } = require('./configs');
    const { resolveProxyAssignment } = require('../../launcher/proxy-resolve');
    const sources = resolveProxyAssignment(proxyListName, {
      getProxyLines: name => store.getProxyLines(name),
      getProxies: () => store.getProxies(),
    }).sources.map(source => source.name);
    return engine.send({
      type: 'set-task-proxy',
      messages: [{
        id: String(id),
        proxyGroup: displayProxyGroup(proxyListName),
        proxySources: sources,
      }],
    });
  };

  const stopSite = site => {
    if (site === 'pokemon') {
      const ids = [...running.pokemon];
      if (ids.length) engine.send({ type: 'stop-tasks', messages: ids.map(id => ({ id })) });
      running.pokemon.clear();
      return { stopped: ids };
    }
    return stopTarget();
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/health') {
      const host = harvest && typeof harvest.snapshot === 'function' ? harvest.snapshot() : {};
      return sendJson(res, {
        ok: true,
        service: 'zyn-web',
        engineConnected: engine.connected(),
        bank: bank.snapshot(),
        harvest: {
          connected: host.connected === true,
          companionCount: Math.max(0, Number(host.companionCount) || 0),
          savedCount: Math.max(0, Number(host.savedCount) || 0),
          lastSavedType: String(host.lastSavedType || ''),
          lastError: String(host.lastError || ''),
          roomId: String(host.roomId || ''),
        },
        running: {
          target: running.target.size,
          pokemon: running.pokemon.size,
          monitors: running.monitors.size,
        },
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
      if (!tokenMatches(req, webToken) || !sessions || !sessions.fromRequest(req)) {
        return sendJson(res, { ok: false, error: 'unauthorized' }, 401);
      }
      try {
        if (harvest && typeof harvest.stop === 'function') harvest.stop();
        if (license && typeof license.logout === 'function') await license.logout();
        sessions.clear();
      } catch (error) {
        return sendJson(res, { ok: false, error: error.message }, 400);
      }
      res.writeHead(200, {
        'content-type': 'application/json',
        'set-cookie': sessions.clearCookieHeader(cookieOpts(req)),
      });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (url.pathname.startsWith('/api/') && !PUBLIC_API.has(url.pathname)) {
      if (!authorize(req, { webToken, sessions, license })) {
        return sendJson(res, { ok: false, error: 'unauthorized' }, 401);
      }
    }

    try {
      if (req.method === 'GET' && url.pathname === '/api/auth/session') {
        const status = license && typeof license.status === 'function'
          ? license.status()
          : { ok: false, reason: 'Sign in to continue.' };
        const signedIn = !!(sessions && sessions.fromRequest(req) && status.ok);
        return sendJson(res, {
          ok: true,
          signedIn,
          email: signedIn ? (status.email || '') : '',
          sessionKind: status.sessionKind || 'engine',
          requiresPasswordReset: status.requiresPasswordReset === true,
          reason: signedIn ? '' : (status.reason || 'Sign in with your Zyn email and password.'),
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/login') {
        if (!license || !sessions) return sendJson(res, { ok: false, error: 'license host is not configured' }, 503);
        const body = JSON.parse((await readBody(req)) || '{}');
        const status = await license.login({
          email: body.email,
          password: body.password,
        });
        if (status.requiresPasswordReset) {
          return sendJson(res, {
            ok: false,
            requiresPasswordReset: true,
            email: status.email || '',
            error: status.reason || 'Choose a new password to continue.',
          });
        }
        if (!status.ok) {
          return sendJson(res, { ok: false, error: status.reason || 'Unable to sign in.' }, 401);
        }
        const token = sessions.create();
        if (harvest && typeof harvest.start === 'function') harvest.start();
        await publishBankDemand();
        res.writeHead(200, {
          'content-type': 'application/json',
          'set-cookie': sessions.setCookieHeader(token, cookieOpts(req)),
        });
        res.end(JSON.stringify({
          ok: true,
          email: status.email || '',
          sessionKind: status.sessionKind || 'engine',
        }));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/reset') {
        if (!license || !sessions) return sendJson(res, { ok: false, error: 'license host is not configured' }, 503);
        const body = JSON.parse((await readBody(req)) || '{}');
        const status = await license.reset({ newPassword: body.newPassword });
        if (!status.ok) {
          return sendJson(res, { ok: false, error: status.reason || 'Unable to reset password.' }, 401);
        }
        const token = sessions.create();
        if (harvest && typeof harvest.start === 'function') harvest.start();
        await publishBankDemand();
        res.writeHead(200, {
          'content-type': 'application/json',
          'set-cookie': sessions.setCookieHeader(token, cookieOpts(req)),
        });
        res.end(JSON.stringify({
          ok: true,
          email: status.email || '',
          sessionKind: status.sessionKind || 'engine',
        }));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        const status = license && typeof license.status === 'function' ? license.status() : null;
        return sendJson(res, {
          ok: true,
          email: status && status.ok ? (status.email || '') : '',
          harvest: harvest && typeof harvest.snapshot === 'function' ? harvest.snapshot() : null,
          groups: store.taskGroups.load(),
          pokemon: store.getPokemonCenterTasks(),
          walmart: store.getWalmartTasks(),
          profiles: store.getProfiles(),
          accounts: store.getAccountsRaw().map(workspace.publicAccount),
          proxies: store.getProxies().lists.map(list => ({
            name: list.name,
            raw: String(list.raw || ''),
            lines: String(list.raw || '').split('\n').filter(Boolean).length,
          })),
          backup: backup && typeof backup.status === 'function' ? backup.status() : null,
          otp: otp && typeof otp.snapshot === 'function' ? otp.snapshot() : { pending: [] },
          bank: bank.snapshot(),
          engineConnected: engine.connected(),
          running: {
            target: [...running.target],
            pokemon: [...running.pokemon],
          },
        });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/files/')) {
        const name = url.pathname.slice('/api/files/'.length);
        if (!ALLOWED_FILES.has(name)) return sendJson(res, { ok: false, error: 'unknown file' }, 404);
        return sendJson(res, { ok: true, name, value: store.readJSON(name, name === 'proxies.json' ? { lists: [] } : []) });
      }
      if (req.method === 'PUT' && url.pathname.startsWith('/api/files/')) {
        const name = url.pathname.slice('/api/files/'.length);
        if (!ALLOWED_FILES.has(name)) return sendJson(res, { ok: false, error: 'unknown file' }, 404);
        const value = JSON.parse((await readBody(req)) || 'null');
        store.writeJSON(name, value);
        return sendJson(res, { ok: true, name });
      }
      if (req.method === 'POST' && /^\/api\/target\/groups\/[^/]+\/start$/.test(url.pathname)) {
        const id = decodeURIComponent(url.pathname.split('/')[4]);
        return sendJson(res, { ok: true, ...(await startTargetGroup(id)) });
      }
      if (req.method === 'POST' && url.pathname === '/api/target/stop') {
        return sendJson(res, { ok: true, ...stopSite('target') });
      }
      if (req.method === 'POST' && url.pathname === '/api/pokemon/start') {
        return sendJson(res, { ok: true, ...(await startPokemon()) });
      }
      if (req.method === 'POST' && url.pathname === '/api/pokemon/stop') {
        return sendJson(res, { ok: true, ...stopSite('pokemon') });
      }
      if (req.method === 'POST' && url.pathname === '/api/walmart/start') {
        return sendJson(res, { ok: false, error: 'Walmart Full Engine on Linux is not in this cut.' }, 501);
      }
      if (req.method === 'POST' && url.pathname === '/api/profiles') {
        return sendJson(res, { ok: true, profile: workspace.saveProfile(store, JSON.parse((await readBody(req)) || '{}')) });
      }
      if (req.method === 'PUT' && /^\/api\/profiles\/[^/]+$/.test(url.pathname)) {
        const id = decodeURIComponent(url.pathname.split('/')[3]);
        const body = JSON.parse((await readBody(req)) || '{}');
        return sendJson(res, { ok: true, profile: workspace.saveProfile(store, { ...body, id }) });
      }
      if (req.method === 'DELETE' && /^\/api\/profiles\/[^/]+$/.test(url.pathname)) {
        workspace.deleteProfile(store, decodeURIComponent(url.pathname.split('/')[3]));
        return sendJson(res, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/accounts') {
        const body = JSON.parse((await readBody(req)) || '{}');
        if (body.raw) return sendJson(res, { ok: true, ...workspace.addAccountsBulk(store, body.raw, body.site || 'target') });
        return sendJson(res, { ok: true, account: workspace.saveAccount(store, body) });
      }
      if (req.method === 'PUT' && /^\/api\/accounts\/[^/]+$/.test(url.pathname)) {
        const id = decodeURIComponent(url.pathname.split('/')[3]);
        const body = JSON.parse((await readBody(req)) || '{}');
        return sendJson(res, { ok: true, account: workspace.saveAccount(store, { ...body, id }) });
      }
      if (req.method === 'DELETE' && /^\/api\/accounts\/[^/]+$/.test(url.pathname)) {
        workspace.deleteAccount(store, decodeURIComponent(url.pathname.split('/')[3]));
        return sendJson(res, { ok: true });
      }
      if (req.method === 'PUT' && /^\/api\/proxies\/[^/]+$/.test(url.pathname)) {
        const name = decodeURIComponent(url.pathname.split('/')[3]);
        const body = JSON.parse((await readBody(req)) || '{}');
        return sendJson(res, { ok: true, list: workspace.saveProxyList(store, name, body.raw) });
      }
      if (req.method === 'DELETE' && /^\/api\/proxies\/[^/]+$/.test(url.pathname)) {
        workspace.deleteProxyList(store, decodeURIComponent(url.pathname.split('/')[3]));
        return sendJson(res, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/target/groups') {
        const body = JSON.parse((await readBody(req)) || '{}');
        return sendJson(res, { ok: true, group: workspace.saveGroup(store, body) });
      }
      if (req.method === 'PUT' && /^\/api\/target\/groups\/[^/]+$/.test(url.pathname)) {
        const id = decodeURIComponent(url.pathname.split('/')[4]);
        const body = JSON.parse((await readBody(req)) || '{}');
        return sendJson(res, { ok: true, group: workspace.saveGroup(store, { ...body, id }) });
      }
      if (req.method === 'DELETE' && /^\/api\/target\/groups\/[^/]+$/.test(url.pathname)) {
        workspace.deleteGroup(store, decodeURIComponent(url.pathname.split('/')[4]));
        return sendJson(res, { ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/api/backup/status') {
        if (!backup) return sendJson(res, { ok: false, error: 'backup host is not configured' }, 503);
        return sendJson(res, { ok: true, ...backup.status() });
      }
      if (req.method === 'POST' && url.pathname === '/api/backup/key') {
        if (!backup) return sendJson(res, { ok: false, error: 'backup host is not configured' }, 503);
        const body = JSON.parse((await readBody(req)) || '{}');
        const result = backup.importKey(body.recoveryKey, body.expectedFingerprint);
        return sendJson(res, { ok: true, ...result, status: backup.status() });
      }
      if (req.method === 'GET' && url.pathname === '/api/backup/list') {
        if (!backup) return sendJson(res, { ok: false, error: 'backup host is not configured' }, 503);
        return sendJson(res, { ok: true, backups: await backup.list() });
      }
      if (req.method === 'POST' && url.pathname === '/api/backup/preview') {
        if (!backup) return sendJson(res, { ok: false, error: 'backup host is not configured' }, 503);
        const body = JSON.parse((await readBody(req)) || '{}');
        return sendJson(res, await backup.preview(body.backupId, body.mode));
      }
      if (req.method === 'POST' && url.pathname === '/api/backup/restore') {
        if (!backup) return sendJson(res, { ok: false, error: 'backup host is not configured' }, 503);
        stopSite('target');
        stopSite('pokemon');
        const body = JSON.parse((await readBody(req)) || '{}');
        return sendJson(res, await backup.restore(body.backupId, body.mode));
      }
      if (req.method === 'POST' && url.pathname === '/api/backup/import') {
        if (!backup) return sendJson(res, { ok: false, error: 'backup host is not configured' }, 503);
        stopSite('target');
        stopSite('pokemon');
        const body = JSON.parse((await readBody(req, 20e6)) || '{}');
        return sendJson(res, { ok: true, summary: backup.importPayload(body) });
      }
      if (req.method === 'POST' && url.pathname === '/api/otp') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const ok = otp && typeof otp.submit === 'function'
          ? otp.submit(body.email, body.code)
          : engine.send({
            type: 'received-code',
            messages: [{ email: body.email, code: body.code, taskID: body.taskId || body.taskID }],
          });
        return sendJson(res, { ok: ok !== false });
      }
      if (req.method === 'POST' && (url.pathname === '/api/ipc/sync' || url.pathname === '/api/ipc/invoke' || url.pathname === '/api/ipc/send')) {
        const body = JSON.parse((await readBody(req, 8e6)) || '{}');
        const channel = String(body.channel || '');
        const args = Array.isArray(body.args) ? body.args : [];
        const kind = url.pathname.endsWith('/send') ? 'send' : url.pathname.endsWith('/invoke') ? 'invoke' : 'sync';
        const publicChannel = createIpcRouter({}).PUBLIC_CHANNELS.has(channel);
        if (!publicChannel && url.pathname.startsWith('/api/') && !authorize(req, { webToken, sessions, license })) {
          return sendJson(res, { ok: false, error: 'unauthorized' }, 401);
        }
        const router = createIpcRouter({
          store, engine, bank, license, sessions, harvest, backup, otp,
          startTarget, stopTarget, startPokemon, stopPokemon: () => stopSite('pokemon'),
          setTaskProxy, cookieOpts, req,
        });
        const result = await router.dispatch(channel, args, { kind });
        if (router.cookieHeader.value) {
          res.writeHead(200, {
            'content-type': 'application/json',
            'set-cookie': router.cookieHeader.value,
          });
          res.end(JSON.stringify({ ok: true, result }));
          return;
        }
        return sendJson(res, { ok: true, result });
      }
      if (req.method === 'GET' && url.pathname === '/electron-shim.js') {
        const file = path.join(PUBLIC, 'electron-shim.js');
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
        fs.createReadStream(file).pipe(res);
        return;
      }
      const uiRoot = resolveUiRoot();
      if (req.method === 'GET' && uiRoot && (url.pathname === '/' || url.pathname === '/index.html' || url.pathname.startsWith('/static/') || url.pathname === '/zyn-icon.png')) {
        if (url.pathname === '/' || url.pathname === '/index.html') {
          let html = fs.readFileSync(path.join(uiRoot, 'index.html'), 'utf8');
          if (!html.includes('electron-shim.js')) {
            html = html.replace('<head>', '<head><script src="/electron-shim.js"></script>');
          }
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(html);
          return;
        }
        const relative = url.pathname.replace(/^\/+/, '');
        const file = path.normalize(path.join(uiRoot, relative));
        if (!file.startsWith(uiRoot) || !fs.existsSync(file)) return sendJson(res, { ok: false, error: 'not found' }, 404);
        const ext = path.extname(file);
        res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
        fs.createReadStream(file).pipe(res);
        return;
      }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname.startsWith('/ui/'))) {
        const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(4);
        const file = path.normalize(path.join(PUBLIC, relative));
        if (!file.startsWith(PUBLIC)) return sendJson(res, { ok: false }, 403);
        if (!fs.existsSync(file)) return sendJson(res, { ok: false, error: 'not found' }, 404);
        const ext = path.extname(file);
        res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
        fs.createReadStream(file).pipe(res);
        return;
      }
      sendJson(res, { ok: false, error: 'not found' }, 404);
    } catch (error) {
      sendJson(res, { ok: false, error: error.message }, 400);
    }
  });

  const sockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== '/events' || !authorize(req, { webToken, sessions, license })) {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(req, socket, head, ws => {
      clients.add(ws);
      ws.on('close', () => clients.delete(ws));
    });
  });

  return { server, broadcast, handleEngineMessage };
}

module.exports = { createHttpServer, authorize, webEngineDemand };
