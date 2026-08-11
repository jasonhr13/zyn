'use strict';

// The observer integrates the existing Cloudflare license client without making it authoritative.
// The API client in ./license-client.js stays pinned to its reviewed upstream implementation;
// this adapter only owns renderer-safe state, safeStorage persistence, and isolated IPC names.

const fs = require('fs');
const path = require('path');
const { createClient, DEFAULT_API_BASE } = require('./license-client');
const { invalidSessionReason } = require('./license-session-reason');

const SESSION_FILE = 'license-observer-session.json';
const IPC = Object.freeze({
  status: 'controlPlaneLicenseObservationStatus',
  login: 'controlPlaneLicenseObservationLogin',
  reset: 'controlPlaneLicenseObservationReset',
  refresh: 'controlPlaneLicenseObservationRefresh',
  logout: 'controlPlaneLicenseObservationLogout',
});

function cleanEmail(value) {
  return String(value || '').trim().toLowerCase().slice(0, 254);
}

function cleanTaskTypes(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .slice(0, 50)
    .map(([key, enabled]) => [String(key).trim().toLowerCase().slice(0, 64), enabled === true])
    .filter(([key]) => key));
}

function responseReason(result, fallback) {
  if (result && (result.status === 401 || result.status === 403)) {
    return invalidSessionReason(result, fallback);
  }
  return String((result && result.message) || fallback || 'License request failed.').slice(0, 240);
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

function createLicenseObserver({ dataDirectory, safeStorage, api, now = () => Date.now(), logger = console } = {}) {
  if (!dataDirectory) throw new Error('license observer dataDirectory is required');
  const licenseApi = api || createClient({ apiBase: DEFAULT_API_BASE });
  const sessionPath = path.join(dataDirectory, SESSION_FILE);
  let restored = false;
  let token = '';
  let pendingResetToken = '';
  let state = {
    mode: 'observe',
    enforcing: false,
    signedIn: false,
    valid: null,
    email: '',
    expiresAt: 0,
    checkedAt: 0,
    reason: 'Sign in to preview the replacement license session.',
    storage: 'none',
    taskTypes: {},
    proxyAccess: false,
    managedProxyCount: 0,
    requiresPasswordReset: false,
  };

  const rendererStatus = (extra = {}) => ({
    mode: 'observe',
    enforcing: false,
    signedIn: state.signedIn === true,
    valid: state.valid === true ? true : (state.valid === false ? false : null),
    email: cleanEmail(state.email),
    expiresAt: Number(state.expiresAt) || 0,
    checkedAt: Number(state.checkedAt) || 0,
    reason: String(state.reason || '').slice(0, 240),
    storage: ['encrypted', 'memory', 'none'].includes(state.storage) ? state.storage : 'none',
    taskTypes: cleanTaskTypes(state.taskTypes),
    proxyAccess: state.proxyAccess === true,
    managedProxyCount: Math.max(0, Number.parseInt(state.managedProxyCount, 10) || 0),
    requiresPasswordReset: state.requiresPasswordReset === true,
    ...extra,
  });

  const encryptionAvailable = () => {
    try { return Boolean(safeStorage && safeStorage.isEncryptionAvailable()); } catch { return false; }
  };

  const clearPersisted = () => {
    try { if (fs.existsSync(sessionPath)) atomicWrite(sessionPath, {}); } catch (error) {
      logger.warn?.(`[license observer] could not clear session: ${error.message}`);
    }
  };

  const persist = () => {
    if (!token || !encryptionAvailable()) return false;
    let encrypted = '';
    try { encrypted = `enc:${safeStorage.encryptString(token).toString('base64')}`; } catch { return false; }
    if (!encrypted) return false;
    atomicWrite(sessionPath, {
      email: cleanEmail(state.email),
      token: encrypted,
      validatedAt: Number(state.checkedAt) || now(),
      expiresAt: Number(state.expiresAt) || 0,
      taskTypes: cleanTaskTypes(state.taskTypes),
      proxyAccess: state.proxyAccess === true,
      managedProxyCount: Math.max(0, Number.parseInt(state.managedProxyCount, 10) || 0),
    });
    return true;
  };

  const restore = () => {
    if (restored) return;
    restored = true;
    let stored = {};
    try { stored = JSON.parse(fs.readFileSync(sessionPath, 'utf8')); } catch { return; }
    if (!stored || typeof stored !== 'object' || typeof stored.token !== 'string') return;
    if (!stored.token.startsWith('enc:') || !encryptionAvailable()) {
      state = { ...state, reason: 'A saved observer session could not be opened securely.', storage: 'none' };
      return;
    }
    try {
      token = safeStorage.decryptString(Buffer.from(stored.token.slice(4), 'base64'));
    } catch {
      token = '';
    }
    if (!token) {
      state = { ...state, reason: 'A saved observer session could not be decrypted.', storage: 'none' };
      return;
    }
    state = {
      ...state,
      signedIn: true,
      valid: null,
      email: cleanEmail(stored.email),
      expiresAt: Number(stored.expiresAt) || 0,
      checkedAt: Number(stored.validatedAt) || 0,
      reason: 'Saved session loaded. Re-check to validate it with the license service.',
      storage: 'encrypted',
      taskTypes: cleanTaskTypes(stored.taskTypes),
      proxyAccess: stored.proxyAccess === true,
      managedProxyCount: Math.max(0, Number.parseInt(stored.managedProxyCount, 10) || 0),
    };
  };

  const accept = (result) => {
    token = String(result.licenseToken || token || '');
    pendingResetToken = '';
    const managedProxyCount = Number.isFinite(Number(result.proxyListCount))
      ? Number(result.proxyListCount)
      : (Array.isArray(result.managedProxyLists) ? result.managedProxyLists.length : 0);
    state = {
      ...state,
      signedIn: Boolean(token),
      valid: true,
      email: cleanEmail(result.email || state.email),
      expiresAt: Number(result.expiresAt) || 0,
      checkedAt: now(),
      reason: '',
      taskTypes: cleanTaskTypes(result.taskTypes),
      proxyAccess: result.proxyAccess === true,
      managedProxyCount,
      requiresPasswordReset: false,
    };
    state.storage = persist() ? 'encrypted' : 'memory';
    return rendererStatus();
  };

  const networkFailure = (action, error) => {
    logger.warn?.(`[license observer] ${action}: ${error.message}`);
    state = {
      ...state,
      valid: state.signedIn ? null : state.valid,
      reason: 'Cannot reach the license server. The current R3 app session is unaffected.',
    };
    return rendererStatus();
  };

  return Object.freeze({
    sessionPath,
    status() {
      restore();
      return rendererStatus();
    },
    async login(credentials = {}) {
      restore();
      const email = cleanEmail(credentials.email);
      const password = String(credentials.password || '').slice(0, 256);
      if (!email || !password) {
        state = { ...state, reason: 'Enter your email and password.' };
        return rendererStatus();
      }
      try {
        const result = await licenseApi.login(email, password);
        if (result.ok && result.licenseToken) return accept(result);
        if (result.code === 'password_reset_required' && result.resetToken) {
          pendingResetToken = String(result.resetToken).slice(0, 256);
          state = {
            ...state,
            signedIn: false,
            valid: null,
            email: cleanEmail(result.email || email),
            reason: responseReason(result, 'Choose a new password to continue.'),
            requiresPasswordReset: true,
          };
          return rendererStatus();
        }
        state = { ...state, valid: null, reason: responseReason(result, 'Unable to sign in.') };
        return rendererStatus();
      } catch (error) {
        return networkFailure('login unavailable', error);
      }
    },
    async reset(payload = {}) {
      const newPassword = String(payload.newPassword || '').slice(0, 256);
      if (!pendingResetToken || newPassword.length < 10) {
        state = { ...state, reason: pendingResetToken
          ? 'Use a password of at least 10 characters.'
          : 'The password reset session is no longer available. Sign in again.' };
        return rendererStatus();
      }
      try {
        const result = await licenseApi.resetPassword(pendingResetToken, newPassword);
        if (result.ok && result.licenseToken) return accept(result);
        if (result.status === 401 || result.status === 403) {
          pendingResetToken = '';
          state = { ...state, requiresPasswordReset: false };
        }
        state = { ...state, reason: responseReason(result, 'Unable to reset password.') };
        return rendererStatus();
      } catch (error) {
        return networkFailure('password reset unavailable', error);
      }
    },
    async refresh() {
      restore();
      if (!token) {
        state = { ...state, signedIn: false, valid: null, reason: 'Sign in before re-checking.' };
        return rendererStatus();
      }
      try {
        const result = await licenseApi.validate(token, '');
        if (result.ok) return accept(result);
        if (result.status === 401 || result.status === 403) {
          token = '';
          clearPersisted();
          state = {
            ...state,
            signedIn: false,
            valid: false,
            checkedAt: now(),
            reason: responseReason(result),
            storage: 'none',
          };
          return rendererStatus();
        }
        throw new Error(result.message || `license server returned ${result.status || 0}`);
      } catch (error) {
        return networkFailure('validation unavailable', error);
      }
    },
    async logout() {
      restore();
      const currentToken = token;
      token = '';
      pendingResetToken = '';
      clearPersisted();
      state = {
        mode: 'observe', enforcing: false, signedIn: false, valid: null, email: '',
        expiresAt: 0, checkedAt: now(), reason: 'Signed out of the replacement license preview.',
        storage: 'none', taskTypes: {}, proxyAccess: false, managedProxyCount: 0,
        requiresPasswordReset: false,
      };
      try {
        if (currentToken) await licenseApi.logout(currentToken);
      } catch (error) {
        logger.warn?.(`[license observer] logout: ${error.message}`);
        state.reason = 'Signed out locally; the license service could not be reached.';
      }
      return rendererStatus();
    },
  });
}

function installLicenseObservation({ app, ipcMain, safeStorage, logger = console } = {}) {
  const apiBase = !app.isPackaged && process.env.ZYN_LICENSE_API_URL
    ? process.env.ZYN_LICENSE_API_URL
    : DEFAULT_API_BASE;
  const observer = createLicenseObserver({
    dataDirectory: app.getPath('userData'),
    safeStorage,
    api: createClient({ apiBase }),
    logger,
  });
  ipcMain.handle(IPC.status, () => observer.status());
  ipcMain.handle(IPC.login, (_event, credentials) => observer.login(credentials));
  ipcMain.handle(IPC.reset, (_event, payload) => observer.reset(payload));
  ipcMain.handle(IPC.refresh, () => observer.refresh());
  ipcMain.handle(IPC.logout, () => observer.logout());
  return observer;
}

module.exports = { SESSION_FILE, IPC, cleanTaskTypes, createLicenseObserver, installLicenseObservation };
