'use strict';

const MANAGED_PREFIX = 'managed:';
const START_CHANNELS = new Set([
  'startTask',
  'startPbandai',
  'startPbandaiRotate',
  'startCouponCheck',
  'startRound1',
  'startPokemonCenter',
  'startTarget',
  'editTargetTasks',
  'setTargetTaskProxy',
]);
const MANAGED_BOT_SCRIPTS = new Set([
  'pbandai-register.mjs',
  'riotgames-register.mjs',
  'target-register.mjs',
]);

function collectManagedRefs(channel, args, dataManager) {
  const refs = [];
  const add = value => {
    const ref = String(value || '');
    if (ref.startsWith(MANAGED_PREFIX)) refs.push(ref);
  };
  const walkTask = task => {
    if (!task || typeof task !== 'object') return;
    add(task.proxyList);
    add(task.proxyListName);
  };
  const first = args[0];
  if (channel === 'startTask') {
    const id = first && typeof first === 'object' ? first.id : first;
    const task = (dataManager.getTasks?.() || []).find(item => String(item.id) === String(id || ''));
    walkTask(task);
  } else if (channel === 'setTargetTaskProxy') {
    add(args[1]);
  } else {
    walkTask(first);
    if (Array.isArray(first?.tasks)) first.tasks.forEach(walkTask);
    add(first?.harvesterProxyList);
    add(first?.targetHarvesterProxyList);
    if (channel === 'startTarget' || channel === 'editTargetTasks') {
      const settings = dataManager.getSettings?.() || {};
      add(settings.targetHarvesterProxyList);
      add(settings.targetThrottleFallbackGroup);
    }
  }
  return [...new Set(refs)];
}

function parseProxyLine(line) {
  const value = String(line || '').trim();
  if (!value) return null;
  if (value.includes('://')) {
    try {
      const url = new URL(value);
      if (!['http:', 'https:', 'socks4:', 'socks5:'].includes(url.protocol)) return null;
      const port = Number.parseInt(url.port, 10);
      if (!url.hostname || !Number.isInteger(port) || port < 1 || port > 65535) return null;
      const hostname = url.hostname.startsWith('[') ? url.hostname
        : (url.hostname.includes(':') ? `[${url.hostname}]` : url.hostname);
      const decode = input => { try { return decodeURIComponent(input); } catch { return input; } };
      return {
        server: `${url.protocol}//${hostname}:${url.port}`,
        user: decode(url.username || ''),
        pass: decode(url.password || ''),
      };
    } catch { return null; }
  }

  const ipv6 = value.match(/^\[([^\]]+)\]:(\d+)(?::([^:]*)(?::(.*))?)?$/);
  if (ipv6) {
    const port = Number.parseInt(ipv6[2], 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { server: `[${ipv6[1]}]:${ipv6[2]}`, user: ipv6[3] || '', pass: ipv6[4] || '' };
  }

  const parts = value.split(':');
  const host = parts.shift() || '';
  const portText = parts.shift() || '';
  const port = Number.parseInt(portText, 10);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { server: `${host}:${portText}`, user: parts.shift() || '', pass: parts.join(':') };
}

function proxyArgs(line) {
  const parsed = parseProxyLine(line);
  if (!parsed) return [];
  const args = [`--proxyServer=${parsed.server}`];
  if (parsed.user) args.push(`--proxyUser=${parsed.user}`);
  if (parsed.pass) args.push(`--proxyPass=${parsed.pass}`);
  return args;
}

function installManagedProxyIpcGuard({ ipcMain, dataManager, control, onBlocked = () => {} } = {}) {
  if (!ipcMain || typeof ipcMain.on !== 'function' || typeof ipcMain.handle !== 'function') {
    throw new Error('ipcMain on/handle are required');
  }
  if (!dataManager || typeof dataManager !== 'object') throw new Error('managed proxy dataManager is required');
  if (!control || typeof control.getProxyLines !== 'function') throw new Error('managed proxy control is required');

  const validate = (channel, refs) => {
    for (const ref of refs) {
      try { control.getProxyLines(ref); }
      catch (error) {
        const message = error?.message || 'This managed proxy list is no longer available.';
        onBlocked({ channel, ref, message });
        return message;
      }
    }
    return '';
  };

  const originalOn = ipcMain.on;
  const originalHandle = ipcMain.handle;
  function guardedOn(channel, listener) {
    if (!START_CHANNELS.has(channel) || typeof listener !== 'function') {
      return originalOn.call(this, channel, listener);
    }
    return originalOn.call(this, channel, function managedProxyListener(event, ...args) {
      const message = validate(channel, collectManagedRefs(channel, args, dataManager));
      if (message) {
        if (event) event.returnValue = false;
        try { event?.sender?.send?.('managedProxyError', message); } catch {}
        return undefined;
      }
      return listener.call(this, event, ...args);
    });
  }

  function guardedHandle(channel, listener) {
    if (channel !== 'runBotScript' || typeof listener !== 'function') {
      return originalHandle.call(this, channel, listener);
    }
    return originalHandle.call(this, channel, function managedBotScript(event, scriptName, args, runId, proxyRef) {
      const ref = String(proxyRef || '');
      if (!ref.startsWith(MANAGED_PREFIX)) return listener.call(this, event, scriptName, args, runId);
      if (!MANAGED_BOT_SCRIPTS.has(String(scriptName || ''))) {
        return { success: false, error: 'Managed proxies are available only to supported account-generation modules.' };
      }
      const message = validate(channel, [ref]);
      if (message) return { success: false, error: message };
      const selected = control.pickProxyLine(ref);
      const injected = proxyArgs(selected);
      if (!injected.length) return { success: false, error: 'The selected managed proxy list is empty or invalid.' };
      return listener.call(this, event, scriptName, [...(Array.isArray(args) ? args : []), ...injected], runId);
    });
  }

  ipcMain.on = guardedOn;
  ipcMain.handle = guardedHandle;
  return () => {
    if (ipcMain.handle === guardedHandle) ipcMain.handle = originalHandle;
    if (ipcMain.on === guardedOn) ipcMain.on = originalOn;
  };
}

module.exports = { START_CHANNELS, MANAGED_BOT_SCRIPTS, collectManagedRefs, parseProxyLine, proxyArgs, installManagedProxyIpcGuard };
