'use strict';

const crypto = require('crypto');
const { normalizeGroup } = require('../../launcher/task-group-store');
const { encryptSecret, decryptSecret, decodeCookie } = require('./secrets');
const { sanitizeImapPassword } = require('../../launcher/imap-password');

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function persistPassword(value) {
  const text = String(value == null ? '' : value);
  if (!text) return '';
  if (text.startsWith('b64:') || text.startsWith('enc:')) return text;
  return encryptSecret(text);
}

function decodeSecret(value) {
  const text = String(value == null ? '' : value);
  if (!text) return '';
  try {
    if (text.startsWith('b64:') || text.startsWith('enc:')) return decryptSecret(text);
  } catch {
    return '';
  }
  return text;
}

function persistProfileSecrets(profile) {
  if (!profile || typeof profile !== 'object') return profile;
  const next = { ...profile };
  if (profile.imap) {
    const imap = { ...profile.imap };
    const stored = String(imap.password || imap.pass || '');
    imap.password = stored.startsWith('enc:')
      ? stored
      : persistPassword(sanitizeImapPassword(decodeSecret(stored)));
    next.imap = imap;
  }
  if (profile.payment && typeof profile.payment === 'object') {
    const payment = { ...profile.payment };
    for (const field of ['cardNumber', 'cardCvv']) {
      if (payment[field]) payment[field] = persistPassword(decodeSecret(payment[field]));
    }
    next.payment = payment;
  }
  return next;
}

function profileHasImap(profile) {
  const raw = profile && profile.imap;
  if (!raw || typeof raw !== 'object') return false;
  return Boolean(String(raw.host || '').trim() && String(raw.user || '').trim() && String(raw.password || raw.pass || '').trim());
}

function getProfileImap(store, profileId, email) {
  const profiles = store.getProfiles();
  const wantedId = String(profileId || '');
  const wantedEmail = String(email || '').trim().toLowerCase();
  const targetProfiles = profiles.filter(item => item && item.profileType !== 'pokemoncenter');
  const byId = wantedId && targetProfiles.find(item => String(item.id) === wantedId);
  const byEmail = wantedEmail && targetProfiles.find(item => String(item.email || '').trim().toLowerCase() === wantedEmail);
  const byMailbox = wantedEmail && targetProfiles.find(item => (
    String((item.imap && item.imap.user) || '').trim().toLowerCase() === wantedEmail
  ));
  const profile = (profileHasImap(byId) && byId)
    || (profileHasImap(byEmail) && byEmail)
    || (profileHasImap(byMailbox) && byMailbox)
    || byId
    || byEmail
    || byMailbox
    || null;
  const raw = (profile && profile.imap) || {};
  const storedPassword = String(raw.password || raw.pass || '');
  const encrypted = storedPassword.startsWith('enc:');
  return {
    host: String(raw.host || '').trim(),
    port: Number(raw.port) || 993,
    user: String(raw.user || '').trim(),
    password: encrypted ? '' : sanitizeImapPassword(decodeSecret(storedPassword)),
    encrypted,
    profileId: profile && profile.id || '',
    profileName: profile && (profile.profileName || profile.email) || '',
  };
}

function accountKey(account) {
  const email = String((account && account.email) || '').trim().toLowerCase();
  const site = String((account && account.site) || '').trim().toLowerCase() || 'target';
  return email ? JSON.stringify([site, email]) : '';
}

function matchingProfile(profiles, email, site) {
  const want = String(email || '').trim().toLowerCase();
  const wantSite = String(site || '').trim().toLowerCase() || 'target';
  if (!want) return null;
  return (Array.isArray(profiles) ? profiles : []).find(profile => {
    if (String(profile.email || '').trim().toLowerCase() !== want) return false;
    const type = String(profile.profileType || 'target').trim().toLowerCase() || 'target';
    return type === wantSite || type === 'target';
  }) || null;
}

function publicAccount(account) {
  return {
    id: account.id,
    email: account.email || '',
    site: account.site || 'target',
    profileId: account.profileId || '',
    groups: account.groups || [],
    hasPassword: !!account.password,
    hasSession: !!decodeCookie(account.cookie),
  };
}

function mergeById(current, incoming) {
  const list = Array.isArray(current) ? current.slice() : [];
  const have = new Set(list.map(item => item && item.id).filter(Boolean));
  let added = 0;
  for (const item of Array.isArray(incoming) ? incoming : []) {
    if (!item || !item.id || have.has(item.id)) continue;
    list.push(item);
    have.add(item.id);
    added += 1;
  }
  return { merged: list, added };
}

function createWorkspaceData(store) {
  const exportAll = () => {
    const settings = { ...store.getSettings() };
    return {
      app: 'zyn',
      kind: 'settings-export',
      version: 1,
      exportedAt: Date.now(),
      profiles: store.getProfiles(),
      accounts: store.getAccountsRaw().map(account => {
        const { password, ...rest } = account;
        let plain = '';
        try { plain = decryptSecret(password); } catch { plain = ''; }
        return { ...rest, password: plain };
      }),
      proxies: store.getProxies(),
      settings,
      lastOrders: store.readJSON('last-orders.json', {}),
    };
  };

  const importAll = (bundle, mode = 'merge') => {
    const legacyApp = ['secret', 'lair', 'bot'].join('-');
    if (!bundle || (bundle.app !== 'zyn' && bundle.app !== legacyApp)) {
      throw new Error('Not a Zyn export file.');
    }
    const replace = mode === 'replace';
    const summary = {};

    if (Array.isArray(bundle.profiles)) {
      const encoded = bundle.profiles.map(persistProfileSecrets);
      if (replace) {
        store.saveProfiles(encoded);
        summary.profiles = { set: encoded.length };
      } else {
        const result = mergeById(store.getProfiles(), encoded);
        store.saveProfiles(result.merged);
        summary.profiles = { added: result.added };
      }
    }

    if (Array.isArray(bundle.accounts)) {
      const encode = account => ({ ...account, password: persistPassword(account.password) });
      if (replace) {
        store.saveAccounts(bundle.accounts.map(encode));
        summary.accounts = { set: bundle.accounts.length };
      } else {
        const current = store.getAccountsRaw();
        const have = new Set(current.map(accountKey).filter(Boolean));
        let added = 0;
        let cookies = 0;
        for (const account of bundle.accounts) {
          const key = accountKey(account);
          if (!key) continue;
          if (!have.has(key)) {
            current.push(encode(account.id ? account : { ...account, id: newId('acct') }));
            have.add(key);
            added += 1;
            continue;
          }
          const incomingCookie = String((account && account.cookie) || '').trim();
          if (!incomingCookie) continue;
          const existing = current.find(row => accountKey(row) === key);
          if (existing && !String(existing.cookie || '').trim()) {
            existing.cookie = incomingCookie;
            cookies += 1;
          }
        }
        store.saveAccounts(current);
        summary.accounts = cookies ? { added, cookies } : { added };
      }
    }

    if (bundle.proxies && Array.isArray(bundle.proxies.lists)) {
      if (replace) {
        store.saveProxies(bundle.proxies);
        summary.proxies = { set: bundle.proxies.lists.length };
      } else {
        const current = store.getProxies();
        const byName = new Map(current.lists.map(list => [list.name, list]));
        let added = 0;
        let updated = 0;
        for (const list of bundle.proxies.lists) {
          if (!list || !list.name) continue;
          if (byName.has(list.name)) {
            byName.get(list.name).raw = list.raw;
            updated += 1;
          } else {
            current.lists.push({ name: list.name, raw: list.raw || '' });
            added += 1;
          }
        }
        store.saveProxies(current);
        summary.proxies = { added, updated };
      }
    }

    if (bundle.settings && typeof bundle.settings === 'object') {
      const current = replace ? {} : store.getSettings();
      store.saveSettings({ ...current, ...bundle.settings });
      summary.settings = { keys: Object.keys(bundle.settings).length };
    }

    if (bundle.lastOrders && typeof bundle.lastOrders === 'object') {
      const current = replace ? {} : store.readJSON('last-orders.json', {});
      for (const key of Object.keys(bundle.lastOrders)) {
        current[key] = Math.max(current[key] || 0, bundle.lastOrders[key] || 0);
      }
      store.writeJSON('last-orders.json', current);
      summary.lastOrders = { keys: Object.keys(bundle.lastOrders).length };
    }

    return summary;
  };

  return {
    getProfiles: () => store.getProfiles(),
    getAccountsRaw: () => store.getAccountsRaw(),
    getProxies: () => store.getProxies(),
    getSettings: () => store.getSettings(),
    saveSettings: settings => store.saveSettings(settings),
    getTasks: () => store.readJSON('tasks.json', []),
    getTargetTasks: () => store.readJSON('target-tasks.json', { skus: '', tasks: [] }),
    saveTargetTasks: value => store.writeJSON('target-tasks.json', value),
    getRound1Profiles: () => store.readJSON('round1-profiles.json', []),
    saveRound1Profiles: value => store.writeJSON('round1-profiles.json', value),
    getWatchlist: () => {
      const value = store.readJSON('watchlist.json', '');
      return typeof value === 'string' ? value : '';
    },
    saveWatchlist: value => store.writeJSON('watchlist.json', String(value || '')),
    getPokemonCenterTasks: () => store.getPokemonCenterTasks(),
    savePokemonCenterTasks: value => store.savePokemonCenterTasks(value),
    getLastOrders: () => store.readJSON('last-orders.json', {}),
    exportAll,
    importAll,
  };
}

function addAccountsBulk(store, raw, site = 'target') {
  const accounts = store.getAccountsRaw();
  const profiles = store.getProfiles();
  const now = Date.now();
  const wantSite = String(site || 'target').trim().toLowerCase() || 'target';
  let added = 0;
  let updated = 0;
  let skipped = 0;
  for (const line of String(raw == null ? '' : raw).split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    const index = text.indexOf(':');
    const email = index > 0 ? text.slice(0, index).trim() : '';
    const password = index > 0 ? text.slice(index + 1).trim() : '';
    if (!email || !password || !email.includes('@')) {
      skipped += 1;
      continue;
    }
    const existing = accounts.find(account => (
      String(account.email || '').toLowerCase() === email.toLowerCase()
      && String(account.site || 'target').toLowerCase() === wantSite
    ));
    if (existing) {
      existing.password = persistPassword(password);
      updated += 1;
      continue;
    }
    const match = matchingProfile(profiles, email, wantSite);
    accounts.push({
      id: newId('acct'),
      email,
      password: persistPassword(password),
      profileId: match ? match.id : null,
      createdAt: now,
      source: 'manual',
      site: wantSite,
    });
    added += 1;
  }
  store.saveAccounts(accounts);
  return { added, updated, skipped, total: accounts.length };
}

function saveProfile(store, input = {}) {
  const profiles = store.getProfiles();
  const id = String(input.id || newId('prof'));
  const index = profiles.findIndex(profile => String(profile.id) === id);
  const current = index >= 0 ? profiles[index] : {};
  const next = persistProfileSecrets({
    ...current,
    ...input,
    id,
    profileType: input.profileType || current.profileType || 'target',
    imap: input.imap
      ? {
        ...current.imap,
        ...input.imap,
        password: input.imap.password || (current.imap && current.imap.password) || '',
      }
      : current.imap,
  });
  if (index >= 0) profiles[index] = next;
  else profiles.push(next);
  store.saveProfiles(profiles);
  return next;
}

function deleteProfile(store, id) {
  store.saveProfiles(store.getProfiles().filter(profile => String(profile.id) !== String(id)));
}

function saveAccount(store, input = {}) {
  const accounts = store.getAccountsRaw();
  const id = String(input.id || newId('acct'));
  const index = accounts.findIndex(account => String(account.id) === id);
  const current = index >= 0 ? accounts[index] : { id, createdAt: Date.now(), source: 'manual' };
  const next = {
    ...current,
    id,
    email: input.email != null ? String(input.email).trim() : current.email,
    site: input.site != null ? String(input.site).trim() || 'target' : (current.site || 'target'),
    profileId: input.profileId != null ? input.profileId : current.profileId,
    groups: Array.isArray(input.groups) ? input.groups : current.groups,
  };
  if (input.password) next.password = persistPassword(input.password);
  if (input.cookie != null) next.cookie = String(input.cookie);
  if (index >= 0) accounts[index] = next;
  else {
    if (!next.password) throw new Error('Account password is required.');
    accounts.push(next);
  }
  store.saveAccounts(accounts);
  return publicAccount(next);
}

function deleteAccount(store, id) {
  store.saveAccounts(store.getAccountsRaw().filter(account => String(account.id) !== String(id)));
}

function saveProxyList(store, name, raw) {
  const listName = String(name || '').trim();
  if (!listName) throw new Error('Proxy list name is required.');
  const data = store.getProxies();
  const index = data.lists.findIndex(list => list.name === listName);
  const next = { name: listName, raw: String(raw == null ? '' : raw) };
  if (index >= 0) data.lists[index] = next;
  else data.lists.push(next);
  store.saveProxies(data);
  return next;
}

function deleteProxyList(store, name) {
  const data = store.getProxies();
  data.lists = data.lists.filter(list => list.name !== String(name));
  store.saveProxies(data);
}

function saveGroup(store, input = {}) {
  const groups = store.taskGroups.load();
  const existing = input.id ? groups.find(group => group.id === String(input.id)) : null;
  const payload = { ...input };
  if (input.tasksFromAccounts === true) {
    payload.tasks = tasksFromAccounts(store, { proxyListName: input.proxyListName });
  } else if (!Array.isArray(payload.tasks) && existing) {
    payload.tasks = existing.tasks;
  }
  const next = normalizeGroup(payload, groups.length);
  const index = groups.findIndex(group => group.id === next.id);
  if (index >= 0) groups[index] = next;
  else groups.push(next);
  store.taskGroups.save(groups);
  return next;
}

function deleteGroup(store, id) {
  store.taskGroups.save(store.taskGroups.load().filter(group => group.id !== String(id)));
}

function tasksFromAccounts(store, { proxyListName = '', profileId = '' } = {}) {
  const profiles = store.getProfiles();
  return store.getAccountsRaw()
    .filter(account => String(account.site || 'target').toLowerCase() === 'target')
    .map(account => {
      const profile = profileId
        ? profiles.find(item => item.id === profileId)
        : matchingProfile(profiles, account.email, 'target');
      return {
        id: newId('task'),
        accountId: account.id,
        profileId: (profile && profile.id) || account.profileId || '',
        proxyListName,
      };
    })
    .filter(task => task.profileId);
}

module.exports = {
  createWorkspaceData,
  publicAccount,
  addAccountsBulk,
  saveProfile,
  deleteProfile,
  saveAccount,
  deleteAccount,
  saveProxyList,
  deleteProxyList,
  saveGroup,
  deleteGroup,
  tasksFromAccounts,
  persistPassword,
  persistProfileSecrets,
  getProfileImap,
};
