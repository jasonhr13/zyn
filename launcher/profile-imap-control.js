'use strict';

// Integration adapter for the profile-owned IMAP schema. The normalization,
// migration, secret encoding, and lookup rules below follow its data-manager implementation while
// leaving the archived R5 data manager and every unrelated record type untouched.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { sanitizeImapPassword } = require('./imap-password');

const PROFILE_IMAP_MIGRATION_VERSION = 1;
const PROFILE_FILE = 'profiles.json';
const SETTINGS_FILE = 'settings.json';

function createProfileImapControl({ dataDirectory, safeStorage, dataManager, logger = console } = {}) {
  if (!dataDirectory) throw new Error('profile IMAP dataDirectory is required');
  if (!dataManager || typeof dataManager !== 'object') throw new Error('profile IMAP dataManager is required');

  const filePath = filename => path.join(dataDirectory, filename);
  const readJSON = (filename, fallback) => {
    try { return JSON.parse(fs.readFileSync(filePath(filename), 'utf8')); } catch { return fallback; }
  };
  const backupOnce = filename => {
    const source = filePath(filename);
    const backup = filePath(`${filename}.pre-profile-imap-r6.bak`);
    try {
      if (fs.existsSync(source) && !fs.existsSync(backup)) {
        fs.copyFileSync(source, backup);
        fs.chmodSync(backup, 0o600);
      }
    } catch (error) { logger.warn?.(`[profile-imap] backup ${filename}: ${error.message}`); }
  };
  const writeJSON = (filename, value) => {
    fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    const output = filePath(filename);
    const temporary = `${output}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, output);
    fs.chmodSync(output, 0o600);
  };

  function encryptSecret(plain) {
    const value = String(plain == null ? '' : plain);
    if (!value) return '';
    try {
      if (safeStorage && safeStorage.isEncryptionAvailable()) {
        return `enc:${safeStorage.encryptString(value).toString('base64')}`;
      }
    } catch {}
    return `b64:${Buffer.from(value, 'utf8').toString('base64')}`;
  }

  function decryptSecret(stored) {
    const value = String(stored == null ? '' : stored);
    try {
      if (value.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'));
      if (value.startsWith('b64:')) return Buffer.from(value.slice(4), 'base64').toString('utf8');
    } catch {}
    return '';
  }

  function normalizeImapConfig(raw) {
    const value = raw && typeof raw === 'object' ? raw : {};
    return {
      host: String(value.host || '').trim(),
      port: Number(value.port) || 993,
      user: String(value.user || '').trim(),
      password: sanitizeImapPassword(value.password ?? value.pass ?? ''),
    };
  }

  function imapConfigured(config) {
    const value = normalizeImapConfig(config);
    return Boolean(value.host && value.user && value.password);
  }

  function decodeProfileSecrets(profile) {
    if (!profile || typeof profile !== 'object' || !profile.imap) return profile;
    const imap = normalizeImapConfig(profile.imap);
    const stored = imap.password;
    imap.password = sanitizeImapPassword(stored.startsWith('enc:') || stored.startsWith('b64:')
      ? decryptSecret(stored) : stored);
    return { ...profile, imap };
  }

  function encodeProfileSecrets(profile) {
    if (!profile || typeof profile !== 'object' || !profile.imap) return profile;
    const imap = normalizeImapConfig(profile.imap);
    return { ...profile, imap: { ...imap, password: encryptSecret(imap.password) } };
  }

  function writeProfiles(profiles) {
    writeJSON(PROFILE_FILE, (Array.isArray(profiles) ? profiles : []).map(encodeProfileSecrets));
  }

  function legacyImapConfig(settings) {
    const value = settings && typeof settings === 'object' ? settings : {};
    const generated = value.generate || {};
    return normalizeImapConfig({
      host: value.imapHost || generated.imapHostCustom || generated.imapHost || '',
      port: value.imapPort || generated.imapPort || 993,
      user: value.imapUser || generated.imapUser || '',
      password: value.imapPass || generated.imapPass || '',
    });
  }

  function getProfilesRaw() {
    let stored = readJSON(PROFILE_FILE, []);
    const settings = readJSON(SETTINGS_FILE, {});
    if (Number(settings.profileImapMigrationVersion || 0) < PROFILE_IMAP_MIGRATION_VERSION && stored.length) {
      const legacy = legacyImapConfig(settings);
      if (imapConfigured(legacy)) {
        backupOnce(PROFILE_FILE);
        backupOnce(SETTINGS_FILE);
        const decoded = stored.map(decodeProfileSecrets);
        const migrated = decoded.map(profile => {
          const current = normalizeImapConfig(profile && profile.imap);
          const hasAnyProfileValue = Boolean(current.host || current.user || current.password);
          return hasAnyProfileValue ? profile : { ...profile, imap: legacy };
        });
        writeProfiles(migrated);
        stored = readJSON(PROFILE_FILE, []);

        const nextSettings = { ...settings, profileImapMigrationVersion: PROFILE_IMAP_MIGRATION_VERSION };
        for (const key of ['imapHost', 'imapPort', 'imapUser', 'imapPass', 'imapByHost']) delete nextSettings[key];
        writeJSON(SETTINGS_FILE, nextSettings);
      }
    }
    return stored;
  }

  function getProfiles() { return getProfilesRaw().map(decodeProfileSecrets); }

  function getProfileImap(profileId, email) {
    const profiles = getProfiles();
    const wantedId = String(profileId || '');
    const wantedEmail = String(email || '').trim().toLowerCase();
    const targetProfiles = profiles.filter(item => item && item.profileType !== 'pokemoncenter');
    const profile = (wantedId && targetProfiles.find(item => String(item.id) === wantedId))
      || (wantedEmail && targetProfiles.find(item => String(item.email || '').trim().toLowerCase() === wantedEmail));
    const configured = normalizeImapConfig(profile && profile.imap);
    if (imapConfigured(configured)) {
      return { ...configured, profileId: profile.id, profileName: profile.profileName || profile.email || '' };
    }
    const settings = readJSON(SETTINGS_FILE, {});
    if (Number(settings.profileImapMigrationVersion || 0) < PROFILE_IMAP_MIGRATION_VERSION) {
      const legacy = legacyImapConfig(settings);
      if (imapConfigured(legacy)) return legacy;
    }
    return configured;
  }

  function createProfile(data) {
    const profiles = getProfiles();
    const profile = { id: crypto.randomUUID(), ...data };
    profiles.push(profile);
    writeProfiles(profiles);
    return profile;
  }

  function createProfilesBulk(list) {
    const profiles = getProfiles();
    const created = [];
    for (const raw of (Array.isArray(list) ? list : [])) {
      const { id: _discardedId, ...data } = raw || {};
      const profile = { id: crypto.randomUUID(), ...data };
      profiles.push(profile);
      created.push(profile);
    }
    if (created.length) writeProfiles(profiles);
    return created;
  }

  function updateProfile(id, data) {
    writeProfiles(getProfiles().map(profile => profile.id === id ? { ...profile, ...data } : profile));
  }

  function deleteProfile(id) { writeProfiles(getProfiles().filter(profile => profile.id !== id)); }

  function getGroups() {
    const groups = new Set();
    for (const profile of getProfiles()) for (const group of (profile.groups || [])) if (group) groups.add(group);
    return [...groups].sort((left, right) => left.localeCompare(right));
  }

  function addProfilesToGroup(ids, group) {
    const cleanGroup = String(group || '').trim();
    if (!cleanGroup) return 0;
    const selected = new Set((Array.isArray(ids) ? ids : [ids]).map(String));
    let added = 0;
    const profiles = getProfiles().map(profile => {
      if (!selected.has(String(profile.id))) return profile;
      const groups = Array.isArray(profile.groups) ? profile.groups : [];
      if (groups.includes(cleanGroup)) return profile;
      added += 1;
      return { ...profile, groups: [...groups, cleanGroup] };
    });
    if (added) writeProfiles(profiles);
    return added;
  }

  function removeProfilesFromGroup(ids, group) {
    const cleanGroup = String(group || '').trim();
    const selected = new Set((Array.isArray(ids) ? ids : [ids]).map(String));
    writeProfiles(getProfiles().map(profile => selected.has(String(profile.id)) && Array.isArray(profile.groups)
      ? { ...profile, groups: profile.groups.filter(value => value !== cleanGroup) } : profile));
  }

  function setProfileGroups(id, groups) {
    const clean = [...new Set((Array.isArray(groups) ? groups : []).map(value => String(value).trim()).filter(Boolean))];
    updateProfile(id, { groups: clean });
  }

  function importProfiles(incoming, mode) {
    const arriving = Array.isArray(incoming) ? incoming : [];
    if (mode === 'replace') {
      writeProfiles(arriving);
      return { set: arriving.length };
    }
    const current = getProfiles();
    const known = new Set(current.map(profile => profile.id));
    let added = 0;
    for (const profile of arriving) {
      if (profile && profile.id && !known.has(profile.id)) {
        current.push(profile);
        known.add(profile.id);
        added += 1;
      }
    }
    if (added) writeProfiles(current);
    return { added };
  }

  const originalExportAll = typeof dataManager.exportAll === 'function' ? dataManager.exportAll.bind(dataManager) : null;
  const originalImportAll = typeof dataManager.importAll === 'function' ? dataManager.importAll.bind(dataManager) : null;
  Object.assign(dataManager, {
    getProfiles,
    getProfileImap,
    createProfile,
    createProfilesBulk,
    updateProfile,
    deleteProfile,
    getGroups,
    addProfilesToGroup,
    removeProfilesFromGroup,
    setProfileGroups,
  });
  if (originalExportAll) {
    dataManager.exportAll = (...args) => ({ ...originalExportAll(...args), profiles: getProfiles() });
  }
  if (originalImportAll) {
    dataManager.importAll = (bundle, mode = 'merge') => {
      const profiles = Array.isArray(bundle && bundle.profiles) ? bundle.profiles : null;
      const withoutProfiles = bundle && typeof bundle === 'object' ? { ...bundle } : bundle;
      if (withoutProfiles && typeof withoutProfiles === 'object') delete withoutProfiles.profiles;
      const summary = originalImportAll(withoutProfiles, mode);
      if (profiles) summary.profiles = importProfiles(profiles, mode);
      return summary;
    };
  }

  return Object.freeze({
    migrationVersion: PROFILE_IMAP_MIGRATION_VERSION,
    getProfiles,
    getProfileImap,
    importProfiles,
    normalizeImapConfig,
    profilePath: filePath(PROFILE_FILE),
    settingsPath: filePath(SETTINGS_FILE),
  });
}

module.exports = { PROFILE_IMAP_MIGRATION_VERSION, createProfileImapControl };
