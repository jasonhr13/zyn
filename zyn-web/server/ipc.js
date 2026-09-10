'use strict';

const { evaluateTargetReadiness } = require('../../launcher/target-readiness');
const workspace = require('./workspace');

const PUBLIC_CHANNELS = new Set([
  'loginLicense',
  'resetLicensePassword',
  'licenseStatus',
  'getPreferredSessionKind',
  'getAppVersion',
  'getChannel',
]);

function rendererAccounts(store) {
  return store.getAccountsRaw().map(account => workspace.publicAccount(account));
}

function proxyCounts(store, group) {
  const refs = new Set();
  if (group && group.proxyListName) refs.add(group.proxyListName);
  for (const task of (group && group.tasks) || []) {
    if (task.proxyListName) refs.add(task.proxyListName);
  }
  const counts = {};
  for (const ref of refs) {
    const lines = store.getProxyLines(ref);
    counts[ref] = { ok: lines.length > 0, count: lines.length, error: lines.length ? '' : 'missing or empty' };
  }
  return counts;
}

function createIpcRouter(ctx) {
  const {
    store, engine, bank, license, sessions, harvest, backup, otp,
    startTarget, stopTarget, startPokemon, stopPokemon,
    cookieOpts, req,
  } = ctx;

  const cookieHeader = { value: null };
  const status = () => {
    const current = license && license.status ? license.status() : { ok: false, reason: 'Sign in to continue.' };
    return { ...current, sessionKind: 'engine' };
  };

  const handlers = {
    getAppVersion: () => '1.7.57',
    getChannel: () => 'web',
    getPreferredSessionKind: () => 'engine',
    licenseStatus: () => status(),
    getEngineInfo: () => ({
      running: engine && engine.connected && engine.connected() ? '1.2.8' : '',
      installed: '1.2.8',
      path: engine && engine.enginePath || '',
    }),
    runtimeStatus: () => ({ ready: true, state: 'ready', percent: 100 }),
    getDiscordStatus: () => ({ status: 'disconnected' }),
    getProfiles: () => store.getProfiles(),
    getAccounts: () => rendererAccounts(store),
    getProxies: () => store.getProxies(),
    getSettings: () => store.getSettings(),
    getTaskGroups: () => store.taskGroups.load(),
    getGroups: () => {
      const settings = store.getSettings();
      return Array.isArray(settings.profileGroups) ? settings.profileGroups : [];
    },
    getPokemonCenterTasks: () => store.getPokemonCenterTasks(),
    getWalmartTasks: () => store.getWalmartTasks(),
    getTargetTasks: () => store.readJSON('target-tasks.json', { skus: '', tasks: [] }),
    getTargetSkuTitles: () => ({}),
    getTargetProductHistory: () => [],
    getLastOrders: () => store.readJSON('last-orders.json', {}),
    getWatchlist: () => {
      const value = store.readJSON('watchlist.json', '');
      return typeof value === 'string' ? value : '';
    },
    saveSettings: settings => store.saveSettings(settings && typeof settings === 'object' ? settings : {}),
    saveTaskGroups: groups => store.taskGroups.save(groups),
    savePokemonCenterTasks: data => store.savePokemonCenterTasks(data),
    saveWalmartTasks: data => store.saveWalmartTasks(data),
    saveTargetTasks: data => store.writeJSON('target-tasks.json', data),
    saveWatchlist: value => store.writeJSON('watchlist.json', String(value || '')),
    createProfile: data => workspace.saveProfile(store, data || {}),
    createProfilesBulk: list => (Array.isArray(list) ? list : []).map(item => workspace.saveProfile(store, item)),
    updateProfile: payload => workspace.saveProfile(store, { ...(payload && payload.data), id: payload && payload.id }),
    deleteProfile: id => workspace.deleteProfile(store, id),
    addAccountsBulk: payload => workspace.addAccountsBulk(store, payload && payload.raw, (payload && payload.site) || 'target'),
    addGeneratedAccount: payload => {
      workspace.saveAccount(store, payload || {});
      return rendererAccounts(store);
    },
    updateAccount: payload => workspace.saveAccount(store, { ...(payload && payload.data), id: payload && payload.id }),
    deleteAccount: id => workspace.deleteAccount(store, id),
    saveProxyList: payload => workspace.saveProxyList(store, payload && payload.name, payload && payload.raw),
    deleteProxyList: name => workspace.deleteProxyList(store, name),
    createProfileGroup: name => {
      const settings = store.getSettings();
      const groups = Array.isArray(settings.profileGroups) ? settings.profileGroups.slice() : [];
      const label = String(name || '').trim();
      if (label && !groups.includes(label)) groups.push(label);
      store.saveSettings({ ...settings, profileGroups: groups });
      return label;
    },
    targetSubmitOtp: payload => (otp && otp.submit(payload && payload.email, payload && payload.code)) === true,
    syncTargetHarvesters: () => true,
    setTargetTaskProxy: (id, proxyListName) => (
      typeof ctx.setTaskProxy === 'function'
        ? ctx.setTaskProxy(id, proxyListName)
        : false
    ),
    startTarget: config => startTarget(config),
    stopTarget: ids => stopTarget(ids),
    startPokemonCenter: () => startPokemon(),
    stopPokemonCenter: ids => stopPokemon(ids),
    minimize: () => true,
    maximize: () => true,
    close: () => true,
    installUpdate: () => true,
    retryRuntimeSetup: () => ({ ready: true, state: 'ready' }),
  };

  const invokeHandlers = {
    loginLicense: async credentials => {
      if (!license) return { ok: false, reason: 'license host is not configured' };
      const result = await license.login({
        email: credentials && credentials.email,
        password: credentials && credentials.password,
      });
      if (result.ok && sessions) {
        cookieHeader.value = sessions.setCookieHeader(sessions.create(), cookieOpts(req));
        if (harvest && harvest.start) harvest.start();
      }
      return { ...result, sessionKind: 'engine' };
    },
    resetLicensePassword: async payload => {
      if (!license) return { ok: false, reason: 'license host is not configured' };
      const result = await license.reset({ newPassword: payload && payload.newPassword });
      if (result.ok && sessions) {
        cookieHeader.value = sessions.setCookieHeader(sessions.create(), cookieOpts(req));
        if (harvest && harvest.start) harvest.start();
      }
      return { ...result, sessionKind: 'engine' };
    },
    targetCookieBank: async () => {
      const snapshot = bank && bank.snapshot ? bank.snapshot() : { login: 0, atc: 0, demand: {} };
      const host = harvest && harvest.snapshot ? harvest.snapshot() : {};
      return {
        ...snapshot,
        remoteHarvester: {
          role: 'host',
          enabled: host.enabled === true,
          connected: host.connected === true,
          companionCount: Math.max(0, Number(host.companionCount) || 0),
          lastSavedAt: Number(host.lastSavedAt) || 0,
          savedCount: Math.max(0, Number(host.savedCount) || 0),
          lastError: String(host.lastError || ''),
        },
      };
    },
    remoteHarvesterReconnect: async () => {
      if (harvest && harvest.reconnect) return harvest.reconnect();
      if (harvest && harvest.start) harvest.start();
      return { ok: true };
    },
    remoteHarvesterStatus: async () => ({
      sessionKind: 'engine',
      host: harvest && harvest.snapshot ? harvest.snapshot() : null,
      companion: null,
    }),
    targetReadiness: async payload => {
      const group = store.taskGroups.load().find(item => String(item.id) === String(payload && payload.groupId));
      if (!group) {
        return {
          ok: false,
          level: 'blocked',
          blockers: [{ code: 'group-missing', title: 'Task group unavailable', detail: 'The Target task group no longer exists.' }],
          warnings: [],
          checks: [],
        };
      }
      const bankSnap = payload && payload.includeBank === false
        ? null
        : (bank && bank.snapshot ? bank.snapshot() : null);
      return evaluateTargetReadiness(group, {
        taskIds: payload && payload.taskIds,
        accounts: rendererAccounts(store),
        profiles: store.getProfiles(),
        settings: store.getSettings(),
        proxyCounts: proxyCounts(store, group),
        bank: bankSnap,
      });
    },
    cloudBackupStatus: async () => (backup && backup.status ? backup.status() : { available: false }),
    cloudBackupList: async () => {
      const backups = backup && backup.list ? await backup.list() : [];
      return { ok: true, backups };
    },
    cloudBackupImportKey: async payload => {
      if (!backup) return { ok: false, error: 'backup host is not configured' };
      const result = backup.importKey(payload && payload.recoveryKey, payload && payload.expectedFingerprint);
      return { ...result, status: backup.status() };
    },
    cloudBackupPreview: async payload => backup.preview(payload && payload.backupId, payload && payload.mode),
    cloudBackupRestore: async payload => backup.restore(payload && payload.backupId, payload && payload.mode),
  };

  return {
    PUBLIC_CHANNELS,
    cookieHeader,
    async dispatch(channel, args, { kind } = {}) {
      const name = String(channel || '');
      if (invokeHandlers[name] && kind !== 'send') {
        return invokeHandlers[name](...(Array.isArray(args) ? args : [args]));
      }
      if (handlers[name]) {
        return handlers[name](...(Array.isArray(args) ? args : [args]));
      }
      if (kind === 'send') return true;
      return null;
    },
  };
}

module.exports = { createIpcRouter, PUBLIC_CHANNELS };
