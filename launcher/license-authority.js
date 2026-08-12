'use strict';

// Authoritative session lifecycle for Zyn account sign-in. The HTTP/HWID
// implementation remains the byte-for-byte upstream client in ./license-client.js; this module is
// the wrapper integration for safeStorage persistence, renderer-safe status, and enforcement hooks.

const fs = require('fs');
const path = require('path');
const { createClient, DEFAULT_API_BASE } = require('./license-client');
const { invalidSessionReason } = require('./license-session-reason');
const { normalizeTaskTypeAccess, removedTaskTypes } = require('./task-type-access');

const SESSION_FILE = 'license-session.json';
const OBSERVER_SESSION_FILE = 'license-observer-session.json';
const LICENSE_CHECK_MS = 5 * 60 * 1000;
const LICENSE_OFFLINE_GRACE_MS = 15 * 60 * 1000;
const IPC = Object.freeze({
  login: 'loginLicense',
  reset: 'resetLicensePassword',
  logout: 'logoutLicense',
});

const normalizeTaskTypes = normalizeTaskTypeAccess;

function cleanEmail(value) {
  return String(value || '').trim().toLowerCase().slice(0, 254);
}

function cleanAccountId(value) {
  const id = String(value || '').trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)
    ? id : '';
}

function atomicWrite(filePath, value) {
  const directory = path.dirname(filePath);
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, filePath);
    fs.chmodSync(filePath, 0o600);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

function createLicenseAuthority({
  dataDirectory,
  safeStorage,
  api,
  now = () => Date.now(),
  scheduleInterval = setInterval,
  cancelInterval = clearInterval,
  onStatus = () => {},
  onLock = () => {},
  onEntitlementsChanged = () => {},
  onManagedProxies = () => null,
  logger = console,
} = {}) {
  if (!dataDirectory) throw new Error('license authority dataDirectory is required');
  const licenseApi = api || createClient({ apiBase: DEFAULT_API_BASE });
  const sessionPath = path.join(dataDirectory, SESSION_FILE);
  const observerSessionPath = path.join(dataDirectory, OBSERVER_SESSION_FILE);
  let licenseState = { ok: false, reason: 'Sign in to continue.', accountId: '', taskTypes: normalizeTaskTypes() };
  let licenseToken = '';
  let licenseValidatedAt = 0;
  let pendingResetToken = '';
  // Remote list credentials and their revision are process-memory session state. Neither belongs
  // in license-session.json: after a restart the first validation must request a fresh full copy.
  let managedProxyRevision = '';
  let loaded = false;
  let validationInFlight = null;
  let timer = null;

  const rendererStatus = () => ({
    ok: licenseState.ok === true,
    reason: String(licenseState.reason || '').slice(0, 240),
    email: cleanEmail(licenseState.email),
    expiresAt: Number(licenseState.expiresAt) || 0,
    offline: licenseState.offline === true,
    proxyAccess: licenseState.proxyAccess === true,
    managedProxyCount: Math.max(0, Number.parseInt(licenseState.managedProxyCount, 10) || 0),
    taskTypes: normalizeTaskTypes(licenseState.taskTypes),
    requiresPasswordReset: licenseState.requiresPasswordReset === true,
    storage: ['encrypted', 'memory', 'none'].includes(licenseState.storage)
      ? licenseState.storage : (licenseToken ? 'memory' : 'none'),
  });

  const push = () => {
    const status = rendererStatus();
    try { onStatus(status); } catch (error) { logger.warn?.(`[license] status push: ${error.message}`); }
    return status;
  };

  const encryptionAvailable = () => {
    try { return Boolean(safeStorage && safeStorage.isEncryptionAvailable()); } catch { return false; }
  };

  const decryptToken = (stored) => {
    if (!String(stored || '').startsWith('enc:') || !encryptionAvailable()) return '';
    try { return safeStorage.decryptString(Buffer.from(String(stored).slice(4), 'base64')); } catch { return ''; }
  };

  const readSession = () => {
    const candidates = [sessionPath, observerSessionPath];
    for (const filePath of candidates) {
      let stored = {};
      try { stored = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { continue; }
      const token = decryptToken(stored.token);
      if (!token) continue;
      return {
        accountId: cleanAccountId(stored.userId),
        email: cleanEmail(stored.email),
        token,
        validatedAt: Number(stored.validatedAt) || 0,
        expiresAt: Number(stored.expiresAt) || 0,
        taskTypes: normalizeTaskTypes(stored.taskTypes),
        proxyAccess: stored.proxyAccess === true,
        managedProxyCount: Math.max(0, Number.parseInt(stored.managedProxyCount, 10) || 0),
        migratedFromObserver: filePath === observerSessionPath,
      };
    }
    return { accountId: '', email: '', token: '', validatedAt: 0, taskTypes: normalizeTaskTypes(), migratedFromObserver: false };
  };

  const loadSession = () => {
    if (loaded) return readSessionCache();
    loaded = true;
    const saved = readSession();
    licenseToken = saved.token;
    licenseValidatedAt = saved.validatedAt;
    if (licenseToken) {
      licenseState = {
        ...licenseState,
        accountId: saved.accountId,
        email: saved.email,
        expiresAt: saved.expiresAt,
        taskTypes: saved.taskTypes,
        proxyAccess: saved.proxyAccess,
        managedProxyCount: saved.managedProxyCount,
        storage: 'encrypted',
      };
      if (saved.migratedFromObserver && saveSession()) {
        try { atomicWrite(observerSessionPath, {}); } catch {}
      }
    }
    return readSessionCache();
  };

  const readSessionCache = () => ({
    accountId: cleanAccountId(licenseState.accountId),
    email: cleanEmail(licenseState.email),
    token: licenseToken,
    validatedAt: licenseValidatedAt,
    expiresAt: Number(licenseState.expiresAt) || 0,
    taskTypes: normalizeTaskTypes(licenseState.taskTypes),
    proxyAccess: licenseState.proxyAccess === true,
    managedProxyCount: Math.max(0, Number.parseInt(licenseState.managedProxyCount, 10) || 0),
  });

  function saveSession() {
    if (!licenseToken || !encryptionAvailable()) return false;
    let encrypted = '';
    try { encrypted = `enc:${safeStorage.encryptString(licenseToken).toString('base64')}`; } catch { return false; }
    if (!encrypted) return false;
    try {
      atomicWrite(sessionPath, {
        userId: cleanAccountId(licenseState.accountId),
        email: cleanEmail(licenseState.email),
        token: encrypted,
        validatedAt: Number(licenseValidatedAt) || now(),
        taskTypes: normalizeTaskTypes(licenseState.taskTypes),
      });
      return true;
    } catch (error) {
      logger.warn?.(`[license] save session: ${error.message}`);
      return false;
    }
  }

  const clearSession = () => {
    for (const filePath of [sessionPath, observerSessionPath]) {
      try { if (fs.existsSync(filePath) || filePath === sessionPath) atomicWrite(filePath, {}); }
      catch (error) { logger.warn?.(`[license] clear session: ${error.message}`); }
    }
  };

  const acceptLicense = (result, token, validatedAt = now()) => {
    const wasActive = licenseState.ok === true;
    const previousTaskTypes = normalizeTaskTypes(licenseState.taskTypes);
    const nextTaskTypes = normalizeTaskTypes(result.taskTypes);
    let managed = null;
    try { managed = onManagedProxies(result); }
    catch (error) { logger.warn?.(`[license] managed proxy hook: ${error.message}`); }
    const reportedManagedCount = Number.isFinite(Number(result.proxyListCount))
      ? Math.max(0, Number(result.proxyListCount))
      : (Array.isArray(result.managedProxyLists) ? result.managedProxyLists.length : 0);
    const managedProxyCount = Number.isFinite(Number(managed?.count))
      ? Math.max(0, Number(managed.count)) : reportedManagedCount;
    const revisionCandidate = managed && Object.prototype.hasOwnProperty.call(managed, 'revision')
      ? managed.revision : result.proxyRevision;
    managedProxyRevision = /^[a-f0-9]{64}$/i.test(String(revisionCandidate || ''))
      ? String(revisionCandidate).toLowerCase() : '';
    licenseToken = String(token || licenseToken || '');
    licenseValidatedAt = Number(validatedAt) || now();
    pendingResetToken = '';
    licenseState = {
      ok: true,
      reason: '',
      accountId: cleanAccountId(result.userId || licenseState.accountId),
      email: cleanEmail(result.email || licenseState.email),
      expiresAt: Number(result.expiresAt) || 0,
      offline: false,
      proxyAccess: result.proxyAccess === true,
      managedProxyCount,
      taskTypes: nextTaskTypes,
      requiresPasswordReset: false,
      storage: 'memory',
    };
    licenseState.storage = saveSession() ? 'encrypted' : 'memory';
    const removed = wasActive ? removedTaskTypes(previousTaskTypes, nextTaskTypes) : [];
    if (removed.length) {
      try { onEntitlementsChanged({ removed, previous: previousTaskTypes, next: nextTaskTypes }); }
      catch (error) { logger.warn?.(`[license] entitlement hook: ${error.message}`); }
    }
    return push();
  };

  const lock = (reason, { clear = false, stop = true } = {}) => {
    const hadActiveSession = licenseState.ok || Boolean(licenseToken);
    licenseState = {
      ok: false,
      reason: String(reason || 'Your Zyn session ended. Sign in again to continue.').slice(0, 240),
      accountId: clear ? '' : cleanAccountId(licenseState.accountId),
      email: clear ? '' : cleanEmail(licenseState.email),
      taskTypes: normalizeTaskTypes(),
      proxyAccess: false,
      managedProxyCount: 0,
      requiresPasswordReset: false,
      storage: clear ? 'none' : (licenseToken ? licenseState.storage : 'none'),
    };
    pendingResetToken = '';
    managedProxyRevision = '';
    try { onManagedProxies({ proxyAccess: false, proxyRevision: '', managedProxyLists: [], proxyListsChanged: true }); }
    catch (error) { logger.warn?.(`[license] managed proxy clear hook: ${error.message}`); }
    if (clear) {
      licenseToken = '';
      licenseValidatedAt = 0;
      clearSession();
    }
    const status = push();
    if (stop && hadActiveSession) {
      try { onLock(status); } catch (error) { logger.warn?.(`[license] lock hook: ${error.message}`); }
    }
    return status;
  };

  const validate = async () => {
    if (validationInFlight) return validationInFlight;
    validationInFlight = (async () => {
      const saved = loadSession();
      if (!licenseToken) return lock('Sign in to continue.', { clear: false, stop: false });
      try {
        const result = await licenseApi.validate(licenseToken, managedProxyRevision);
        if (result.ok) return acceptLicense(result, licenseToken);
        if (result.status === 401 || result.status === 403) {
          return lock(invalidSessionReason(result), { clear: true });
        }
        throw new Error(result.message || `license server returned ${result.status || 0}`);
      } catch (error) {
        const lastGood = Math.max(Number(saved.validatedAt) || 0, licenseValidatedAt);
        if (lastGood && now() - lastGood <= LICENSE_OFFLINE_GRACE_MS) {
          licenseState = {
            ...licenseState,
            ok: true,
            email: saved.email,
            reason: 'License server temporarily unavailable; retrying.',
            offline: true,
            taskTypes: normalizeTaskTypes(saved.taskTypes),
          };
          logger.warn?.(`[license] validation unavailable within grace: ${error.message}`);
          return push();
        }
        logger.warn?.(`[license] validation unavailable beyond grace: ${error.message}`);
        return lock('Cannot reach the license server. Check your connection and try again.', { clear: false });
      }
    })();
    try { return await validationInFlight; } finally { validationInFlight = null; }
  };

  const revalidateUnauthorized = async (result) => {
    if (Number(result && result.status) === 401) await validate();
  };

  // Cloud-backup requests stay behind the main-process authority. Callers receive only the
  // endpoint result; the bearer token is never returned, persisted in a backup, or exposed to IPC.
  const backupRequest = async (expectedAccountId, method, ...args) => {
    loadSession();
    const accountId = cleanAccountId(licenseState.accountId);
    if (!licenseToken || licenseState.ok !== true || !accountId) {
      return { ok: false, status: 401, message: 'A valid Zyn session is required.' };
    }
    if (expectedAccountId && cleanAccountId(expectedAccountId) !== accountId) {
      return { ok: false, status: 409, message: 'The signed-in Zyn account changed during backup.' };
    }
    try {
      const result = await licenseApi[method](licenseToken, ...args);
      await revalidateUnauthorized(result);
      return result;
    } catch (error) {
      logger.warn?.(`[license] cloud backup unavailable: ${error.message}`);
      return { ok: false, status: 0, message: 'Encrypted backup service is unavailable.' };
    }
  };

  return Object.freeze({
    sessionPath,
    cached: () => rendererStatus(),
    status: ({ force = false } = {}) => {
      loadSession();
      return force || licenseState.reason === 'Sign in to continue.' ? validate() : Promise.resolve(rendererStatus());
    },
    validate,
    async login(credentials = {}) {
      loadSession();
      const email = cleanEmail(credentials.email);
      const password = String(credentials.password || '').slice(0, 256);
      if (!email || !password) return { ...rendererStatus(), reason: 'Enter your email and password.' };
      try {
        const result = await licenseApi.login(email, password);
        if (result.ok && result.licenseToken) return acceptLicense(result, result.licenseToken);
        if (result.code === 'password_reset_required' && result.resetToken) {
          pendingResetToken = String(result.resetToken).slice(0, 256);
          licenseState = {
            ...licenseState,
            ok: false,
            email: cleanEmail(result.email || email),
            reason: String(result.message || 'Choose a new password to continue.').slice(0, 240),
            requiresPasswordReset: true,
          };
          return push();
        }
        return { ...rendererStatus(), reason: String(result.message || 'Unable to sign in.').slice(0, 240), code: result.code };
      } catch (error) {
        logger.warn?.(`[license] login unavailable: ${error.message}`);
        return { ...rendererStatus(), reason: 'Cannot reach the license server. Check your connection and try again.' };
      }
    },
    async reset(payload = {}) {
      const newPassword = String(payload.newPassword || '').slice(0, 256);
      if (!pendingResetToken || newPassword.length < 10) {
        return { ...rendererStatus(), reason: pendingResetToken
          ? 'Use a password of at least 10 characters.'
          : 'This password reset has expired. Sign in again.' };
      }
      try {
        const result = await licenseApi.resetPassword(pendingResetToken, newPassword);
        if (result.ok && result.licenseToken) return acceptLicense(result, result.licenseToken);
        if (result.status === 401 || result.status === 403) pendingResetToken = '';
        return { ...rendererStatus(), reason: String(result.message || 'Unable to reset password.').slice(0, 240), code: result.code };
      } catch (error) {
        logger.warn?.(`[license] password reset unavailable: ${error.message}`);
        return { ...rendererStatus(), reason: 'Cannot reach the license server. Check your connection and try again.' };
      }
    },
    async hyper(operation, payload = {}) {
      loadSession();
      if (!licenseToken || licenseState.ok !== true) {
        return { ok: false, status: 401, body: '', error: 'A valid Zyn session is required.' };
      }
      if (!normalizeTaskTypes(licenseState.taskTypes).pokemoncenter) {
        return { ok: false, status: 403, body: '', error: 'Pokémon Center access is not enabled.' };
      }
      try {
        const result = await licenseApi.hyper(licenseToken, operation, payload);
        await revalidateUnauthorized(result);
        return {
          ok: result.ok === true,
          status: Number(result.status) || 0,
          body: String(result.body || ''),
          error: result.ok === true ? '' : String(result.message || 'Hyper request failed.').slice(0, 240),
        };
      } catch (error) {
        logger.warn?.(`[license] Hyper broker unavailable: ${error.message}`);
        return { ok: false, status: 502, body: '', error: 'Hyper service is unavailable.' };
      }
    },
    async recordAnalytics(events = []) {
      loadSession();
      if (!licenseToken || licenseState.ok !== true) {
        return { ok: false, status: 401, message: 'A valid Zyn session is required.' };
      }
      try {
        const result = await licenseApi.analyticsEvents(licenseToken, events);
        await revalidateUnauthorized(result);
        return result;
      } catch (error) {
        logger.warn?.(`[license] analytics upload unavailable: ${error.message}`);
        return { ok: false, status: 0, message: 'Analytics service is unavailable.' };
      }
    },
    async analyticsDashboard(query = {}) {
      loadSession();
      if (!licenseToken || licenseState.ok !== true) {
        return { ok: false, status: 401, message: 'A valid Zyn session is required.' };
      }
      try {
        const result = await licenseApi.analyticsDashboard(licenseToken, query);
        await revalidateUnauthorized(result);
        return result;
      } catch (error) {
        logger.warn?.(`[license] analytics dashboard unavailable: ${error.message}`);
        return { ok: false, status: 0, message: 'Analytics service is unavailable.' };
      }
    },
    async analyticsCheckouts(query = {}) {
      loadSession();
      if (!licenseToken || licenseState.ok !== true) {
        return { ok: false, status: 401, message: 'A valid Zyn session is required.' };
      }
      try {
        const result = await licenseApi.analyticsCheckouts(licenseToken, query);
        await revalidateUnauthorized(result);
        return result;
      } catch (error) {
        logger.warn?.(`[license] analytics checkouts unavailable: ${error.message}`);
        return { ok: false, status: 0, message: 'Analytics service is unavailable.' };
      }
    },
    async deleteAnalytics() {
      loadSession();
      if (!licenseToken || licenseState.ok !== true) {
        return { ok: false, status: 401, message: 'A valid Zyn session is required.' };
      }
      try {
        const result = await licenseApi.deleteAnalytics(licenseToken);
        await revalidateUnauthorized(result);
        return result;
      } catch (error) {
        logger.warn?.(`[license] analytics deletion unavailable: ${error.message}`);
        return { ok: false, status: 0, message: 'Analytics service is unavailable.' };
      }
    },
    backupAccountId: () => {
      loadSession();
      return cleanAccountId(licenseState.accountId);
    },
    listBackups: expectedAccountId => backupRequest(expectedAccountId, 'listBackups'),
    uploadBackup: (encrypted, metadata = {}, expectedAccountId = '') => backupRequest(
      expectedAccountId, 'uploadBackup', encrypted, metadata,
    ),
    downloadBackup: (backupId, expectedAccountId = '') => backupRequest(
      expectedAccountId, 'downloadBackup', backupId,
    ),
    deleteBackup: (backupId, expectedAccountId = '') => backupRequest(
      expectedAccountId, 'deleteBackup', backupId,
    ),
    openPokemonQueueEvents(handlers = {}) {
      loadSession();
      if (!licenseToken || licenseState.ok !== true) throw new Error('A valid Zyn session is required.');
      if (!normalizeTaskTypes(licenseState.taskTypes).pokemoncenter) {
        throw new Error('Pokémon Center access is not enabled.');
      }
      return licenseApi.queueEvents(licenseToken, handlers);
    },
    async logout() {
      loadSession();
      const token = licenseToken;
      try { if (token) await licenseApi.logout(token); } catch (error) { logger.warn?.(`[license] logout: ${error.message}`); }
      return lock('Signed out.', { clear: true });
    },
    invalidate: reason => lock(reason || 'Your Zyn session was revoked.', { clear: true }),
    start() {
      if (!timer) timer = scheduleInterval(() => validate(), LICENSE_CHECK_MS);
      return timer;
    },
    dispose() {
      if (timer) cancelInterval(timer);
      timer = null;
    },
  });
}

function installLicenseAuthority({ app, ipcMain, safeStorage, apiBase = DEFAULT_API_BASE, onStatus, onLock, onEntitlementsChanged, onManagedProxies, logger } = {}) {
  const authority = createLicenseAuthority({
    dataDirectory: app.getPath('userData'),
    safeStorage,
    api: createClient({ apiBase }),
    onStatus,
    onLock,
    onEntitlementsChanged,
    onManagedProxies,
    logger,
  });
  ipcMain.handle(IPC.login, (_event, credentials) => authority.login(credentials));
  ipcMain.handle(IPC.reset, (_event, payload) => authority.reset(payload));
  ipcMain.handle(IPC.logout, () => authority.logout());
  app.whenReady().then(() => authority.start());
  app.once('will-quit', () => authority.dispose());
  return authority;
}

module.exports = {
  SESSION_FILE,
  LICENSE_CHECK_MS,
  LICENSE_OFFLINE_GRACE_MS,
  IPC,
  normalizeTaskTypes,
  createLicenseAuthority,
  installLicenseAuthority,
};
