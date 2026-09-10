'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { getProfileImap } = require('./workspace');

const UPSTREAM_IMAP_CLIENT = path.resolve(__dirname, '../../native-farmer/imap-client.mjs');
const LOCAL_IMAP_CLIENT = path.resolve(__dirname, 'imap-client.mjs');

function resolveImapClientPath(explicit) {
  if (explicit) return explicit;
  if (fs.existsSync(LOCAL_IMAP_CLIENT)) return LOCAL_IMAP_CLIENT;
  return UPSTREAM_IMAP_CLIENT;
}

// ESM package resolution follows the real file path, not NODE_PATH. native-farmer/imap-client.mjs
// cannot see zyn-web/node_modules, so copy it next to this host before importing.
function stageImapClient(sourcePath) {
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    throw new Error('mailbox reader is missing from this Zyn installation');
  }
  if (path.resolve(sourcePath) === LOCAL_IMAP_CLIENT) return LOCAL_IMAP_CLIENT;
  const bytes = fs.readFileSync(sourcePath);
  try {
    if (fs.readFileSync(LOCAL_IMAP_CLIENT).equals(bytes)) return LOCAL_IMAP_CLIENT;
  } catch {}
  fs.writeFileSync(LOCAL_IMAP_CLIENT, bytes);
  return LOCAL_IMAP_CLIENT;
}

function createOtpHost({
  store,
  engine,
  logger = console,
  imapClientPath = '',
  fetchAuthCode = null,
} = {}) {
  const pending = new Map();
  const fetches = new Map();
  const listeners = [];

  const snapshot = () => ({
    pending: [...pending.values()].map(entry => ({
      email: entry.email,
      taskId: entry.taskId,
      taskIds: entry.waiters ? [...entry.waiters].filter(Boolean) : (entry.taskId ? [entry.taskId] : []),
      since: entry.since,
      phase: entry.phase,
      message: entry.message,
    })),
  });

  const emit = () => {
    const current = snapshot();
    for (const listener of listeners) {
      try { listener(current); } catch {}
    }
    return current;
  };

  const inferTaskId = email => {
    const wanted = String(email || '').trim().toLowerCase();
    if (!wanted) return '';
    const accounts = store.getAccountsRaw();
    for (const group of store.taskGroups.load()) {
      for (const task of group.tasks || []) {
        const account = accounts.find(row => String(row.id) === String(task.accountId));
        if (account && String(account.email || '').trim().toLowerCase() === wanted) {
          return String(task.id || '');
        }
      }
    }
    return '';
  };

  const profileIdForTask = (taskId, email) => {
    const wanted = String(taskId || '');
    const wantedEmail = String(email || '').trim().toLowerCase();
    if (wanted) {
      for (const group of store.taskGroups.load()) {
        const task = (group.tasks || []).find(item => String(item.id) === wanted);
        if (!task) continue;
        if (task.profileId) return task.profileId;
        const account = store.getAccountsRaw().find(row => String(row.id) === String(task.accountId));
        if (account && account.email) {
          const match = store.getProfiles().find(profile => (
            String(profile.email || '').trim().toLowerCase() === String(account.email).trim().toLowerCase()
          ));
          if (match) return match.id;
        }
      }
    }
    if (wantedEmail) {
      const match = store.getProfiles().find(profile => (
        String(profile.email || '').trim().toLowerCase() === wantedEmail
        || String((profile.imap && profile.imap.user) || '').trim().toLowerCase() === wantedEmail
      ));
      if (match) return match.id;
    }
    return '';
  };

  const addWaiter = (entry, taskId) => {
    if (!entry) return;
    if (!entry.waiters) entry.waiters = new Set();
    const id = String(taskId || '');
    if (id) {
      entry.waiters.add(id);
      if (!entry.taskId) entry.taskId = id;
    }
  };

  const deliver = (email, code, source) => {
    const key = String(email || '').toLowerCase();
    const entry = pending.get(key);
    logger.log(`[otp] code found ${source} — submitting it`);
    if (entry) {
      entry.phase = 'submitting';
      entry.message = source === 'entered by hand'
        ? 'Manual code received — submitting…'
        : 'Email code found — submitting…';
      emit();
    }
    const ok = engine.send({
      type: 'received-code',
      messages: [{ email, code: String(code), site: 'Target', taskID: entry && entry.taskId }],
    });
    pending.delete(key);
    setTimeout(emit, 400);
    return ok;
  };

  const abortFetch = (key, reason) => {
    const active = fetches.get(key);
    if (!active) return;
    fetches.delete(key);
    try { active.controller.abort(new Error(reason)); } catch {}
  };

  const loadFetchAuthCode = async () => {
    if (typeof fetchAuthCode === 'function') return fetchAuthCode;
    const source = resolveImapClientPath(imapClientPath);
    const staged = stageImapClient(source);
    const module = await import(pathToFileURL(staged).href);
    if (typeof module.fetchAuthCode !== 'function') throw new Error('mailbox reader is missing fetchAuthCode');
    return module.fetchAuthCode;
  };

  const fetchOtp = async (email, taskId = '') => {
    const addr = String(email || '').trim();
    if (!addr) return;
    const key = addr.toLowerCase();
    const resolvedTaskId = String(taskId || '') || inferTaskId(addr);
    if (fetches.has(key)) {
      const open = pending.get(key);
      if (open) addWaiter(open, resolvedTaskId);
      emit();
      return;
    }
    const controller = new AbortController();
    fetches.set(key, { controller });
    const open = {
      email: addr,
      taskId: resolvedTaskId,
      waiters: new Set(),
      since: Date.now(),
      phase: 'starting',
      message: 'Preparing automatic email lookup…',
    };
    addWaiter(open, resolvedTaskId);
    pending.set(key, open);
    emit();
    try {
      const imap = getProfileImap(store, profileIdForTask(resolvedTaskId, addr), addr);
      if (imap.encrypted) {
        const entry = pending.get(key);
        if (entry) {
          entry.phase = 'manual';
          entry.message = 'IMAP password is desktop-encrypted and cannot be read here — re-save the profile mailbox, or enter the code.';
        }
        emit();
        logger.log('[otp] IMAP password is enc: on Linux — enter the code manually or re-save the profile mailbox');
        return;
      }
      if (!imap.host || !imap.user || !imap.password) {
        const entry = pending.get(key);
        if (entry) {
          entry.phase = 'manual';
          entry.message = 'No IMAP mailbox on this profile — enter the code manually.';
        }
        emit();
        logger.log('[otp] no IMAP mailbox configured — enter the code manually');
        return;
      }
      const entry = pending.get(key);
      if (entry) {
        entry.phase = 'polling';
        entry.message = 'Polling the profile IMAP mailbox for the code…';
      }
      emit();
      logger.log(`[otp] Polling the profile IMAP mailbox (${imap.user}) for ${addr}`);
      let fetch;
      try {
        fetch = await loadFetchAuthCode();
      } catch (error) {
        const failed = pending.get(key);
        if (failed) {
          failed.phase = 'manual';
          failed.message = 'Mailbox reader failed to start — enter the code manually.';
        }
        emit();
        logger.log(`[otp] mailbox reader failed: ${error.message}`);
        return;
      }
      const result = await fetch(
        { host: imap.host, port: imap.port, user: imap.user, password: imap.password },
        addr,
        /(\d{6})/,
        240000,
        {
          fromFilter: 'target',
          relaxTo: true,
          signal: controller.signal,
          receivedAfter: Date.now() - 10000,
          onLog: line => logger.log(`[otp] ${line}`),
        },
      );
      if (!result || !result.code) throw new Error('No new Target code was found in this mailbox');
      if (fetches.get(key) && fetches.get(key).controller === controller) {
        deliver(addr, result.code, 'from profile mailbox');
      }
    } catch (error) {
      if (controller.signal.aborted || error.name === 'AbortError' || error.code === 'ABORT_ERR') return;
      const failed = pending.get(key);
      if (failed) {
        failed.phase = 'manual';
        failed.message = 'Automatic email lookup finished without a code — enter it manually.';
      }
      emit();
      logger.log(`[otp] mailbox lookup failed: ${error.message}`);
    } finally {
      if (fetches.get(key) && fetches.get(key).controller === controller) fetches.delete(key);
    }
  };

  return {
    snapshot,
    subscribe: listener => listeners.push(listener),
    handleRequest(message = {}) {
      if (message.requestId) {
        engine.send({
          type: 'code-watcher-ready',
          messages: [{ requestId: String(message.requestId) }],
        });
      }
      logger.log(`[otp] verification code needed for ${message.email || ''}`);
      fetchOtp(message.email, message.taskID || message.taskId || '');
    },
    submit(email, code) {
      const addr = String(email || '').trim();
      const value = String(code || '').trim();
      if (!addr || !value) return false;
      abortFetch(addr.toLowerCase(), 'Manual OTP supplied');
      return deliver(addr, value, 'entered by hand');
    },
    cancelAll(reason = 'Target run stopped') {
      for (const key of [...fetches.keys()]) abortFetch(key, reason);
      pending.clear();
      emit();
    },
  };
}

module.exports = { createOtpHost, resolveImapClientPath, stageImapClient };
