'use strict';

// Integration adapter for profile-owned secrets. IMAP credentials, full card numbers, and CVVs are
// encoded with Electron safeStorage before profiles.json is written. Callers inside the trusted main
// process still receive the existing plaintext profile shape, so checkout and profile editing keep
// their established contract while legacy files migrate without losing data.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { sanitizeImapPassword } = require('./imap-password');

const PROFILE_IMAP_MIGRATION_VERSION = 1;
const PROFILE_PAYMENT_MIGRATION_VERSION = 1;
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
    if (!profile || typeof profile !== 'object') return profile;
    const next = { ...profile };
    if (profile.imap) {
      const imap = normalizeImapConfig(profile.imap);
      const stored = imap.password;
      imap.password = sanitizeImapPassword(stored.startsWith('enc:') || stored.startsWith('b64:')
        ? decryptSecret(stored) : stored);
      next.imap = imap;
    }
    if (profile.payment && typeof profile.payment === 'object') {
      const payment = { ...profile.payment };
      for (const field of ['cardNumber', 'cardCvv']) {
        const stored = String(payment[field] == null ? '' : payment[field]);
        payment[field] = stored.startsWith('enc:') || stored.startsWith('b64:')
          ? decryptSecret(stored) : stored;
      }
      next.payment = payment;
    }
    for (const field of ['cardNumber', 'cardCvv']) {
      const stored = String(profile[field] == null ? '' : profile[field]);
      if (stored) next[field] = stored.startsWith('enc:') || stored.startsWith('b64:')
        ? decryptSecret(stored) : stored;
    }
    return next;
  }

  function encodeProfileSecrets(profile) {
    if (!profile || typeof profile !== 'object') return profile;
    const next = { ...profile };
    if (profile.imap) {
      const imap = normalizeImapConfig(profile.imap);
      next.imap = { ...imap, password: encryptSecret(imap.password) };
    }
    if (profile.payment && typeof profile.payment === 'object') {
      const payment = { ...profile.payment };
      for (const field of ['cardNumber', 'cardCvv']) payment[field] = encryptSecret(payment[field]);
      next.payment = payment;
    }
    for (const field of ['cardNumber', 'cardCvv']) {
      if (Object.prototype.hasOwnProperty.call(profile, field)) next[field] = encryptSecret(profile[field]);
    }
    return next;
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
    let settings = readJSON(SETTINGS_FILE, {});
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
        settings = nextSettings;
      }
    }
    if (Number(settings.profilePaymentMigrationVersion || 0) < PROFILE_PAYMENT_MIGRATION_VERSION && stored.length) {
      // writeJSON is atomic, so do not leave a second plaintext-card backup behind during this
      // migration. The existing profile array remains untouched if encryption or the write fails.
      writeProfiles(stored.map(decodeProfileSecrets));
      stored = readJSON(PROFILE_FILE, []);
      // R6's one-time IMAP migration backup predates payment encryption and can contain complete
      // profiles. Keep the recovery copy, but protect its card and mailbox secrets too.
      const legacyProfileBackup = `${PROFILE_FILE}.pre-profile-imap-r6.bak`;
      if (fs.existsSync(filePath(legacyProfileBackup))) {
        const backupProfiles = readJSON(legacyProfileBackup, []);
        writeJSON(legacyProfileBackup, backupProfiles.map(profile => encodeProfileSecrets(decodeProfileSecrets(profile))));
      }
      settings = { ...settings, profilePaymentMigrationVersion: PROFILE_PAYMENT_MIGRATION_VERSION };
      writeJSON(SETTINGS_FILE, settings);
    }
    return stored;
  }

  function getProfiles() { return getProfilesRaw().map(decodeProfileSecrets); }

  function normalizeProfileGroups(values) {
    const groups = [];
    const seen = new Set();
    for (const raw of (Array.isArray(values) ? values : [])) {
      const group = String(raw || '').trim();
      const key = group.toLowerCase();
      if (!group || seen.has(key)) continue;
      seen.add(key);
      groups.push(group);
    }
    return groups;
  }

  function groupsForProfile(profile) {
    return normalizeProfileGroups([
      ...(Array.isArray(profile && profile.groups) ? profile.groups : []),
      profile && profile.group,
    ]);
  }

  function registeredProfileGroups() {
    const settings = readJSON(SETTINGS_FILE, {});
    return normalizeProfileGroups(settings.profileGroups);
  }

  function writeRegisteredProfileGroups(groups) {
    const settings = readJSON(SETTINGS_FILE, {});
    writeJSON(SETTINGS_FILE, { ...settings, profileGroups: normalizeProfileGroups(groups) });
  }

  function registerProfileGroups(groups) {
    const current = registeredProfileGroups();
    const merged = normalizeProfileGroups([...current, ...groups]);
    if (merged.length !== current.length) writeRegisteredProfileGroups(merged);
    return merged;
  }

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
    registerProfileGroups(groupsForProfile(profile));
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
    registerProfileGroups(created.flatMap(groupsForProfile));
    return created;
  }

  function updateProfile(id, data) {
    const profiles = getProfiles().map(profile => profile.id === id ? { ...profile, ...data } : profile);
    writeProfiles(profiles);
    const updated = profiles.find(profile => profile.id === id);
    if (updated) registerProfileGroups(groupsForProfile(updated));
  }

  function deleteProfile(id) { writeProfiles(getProfiles().filter(profile => profile.id !== id)); }

  function getGroups() {
    const groups = normalizeProfileGroups([
      ...registeredProfileGroups(),
      ...getProfiles().flatMap(groupsForProfile),
    ]);
    return groups.sort((left, right) => left.localeCompare(right));
  }

  function createProfileGroup(name) {
    const clean = String(name || '').trim();
    if (!clean) throw new Error('Group name is required');
    const existing = getGroups().find(group => group.toLowerCase() === clean.toLowerCase());
    if (existing) return existing;
    writeRegisteredProfileGroups([...registeredProfileGroups(), clean]);
    return clean;
  }

  function renameProfileGroup(from, to) {
    const requested = String(from || '').trim();
    const replacement = String(to || '').trim();
    if (!requested || !replacement) throw new Error('Both group names are required');
    const groups = getGroups();
    const source = groups.find(group => group.toLowerCase() === requested.toLowerCase());
    if (!source) throw new Error(`Profile group “${requested}” was not found`);
    const collision = groups.find(group => group.toLowerCase() === replacement.toLowerCase()
      && group.toLowerCase() !== source.toLowerCase());
    if (collision) throw new Error(`Profile group “${collision}” already exists`);

    const profiles = getProfiles().map(profile => {
      const memberships = groupsForProfile(profile);
      if (!memberships.some(group => group.toLowerCase() === source.toLowerCase())) return profile;
      const nextGroups = normalizeProfileGroups(memberships.map(group => (
        group.toLowerCase() === source.toLowerCase() ? replacement : group
      )));
      const next = { ...profile, groups: nextGroups };
      delete next.group;
      return next;
    });
    writeProfiles(profiles);
    writeRegisteredProfileGroups(normalizeProfileGroups([
      ...registeredProfileGroups().map(group => (
        group.toLowerCase() === source.toLowerCase() ? replacement : group
      )),
      replacement,
    ]));
    return replacement;
  }

  function deleteProfileGroup(name) {
    const requested = String(name || '').trim();
    const source = getGroups().find(group => group.toLowerCase() === requested.toLowerCase());
    if (!source) return 0;
    let affected = 0;
    const profiles = getProfiles().map(profile => {
      const memberships = groupsForProfile(profile);
      if (!memberships.some(group => group.toLowerCase() === source.toLowerCase())) return profile;
      affected += 1;
      const next = {
        ...profile,
        groups: memberships.filter(group => group.toLowerCase() !== source.toLowerCase()),
      };
      delete next.group;
      return next;
    });
    if (affected) writeProfiles(profiles);
    writeRegisteredProfileGroups(registeredProfileGroups()
      .filter(group => group.toLowerCase() !== source.toLowerCase()));
    return affected;
  }

  function addProfilesToGroup(ids, group) {
    const cleanGroup = String(group || '').trim();
    if (!cleanGroup) return 0;
    const selected = new Set((Array.isArray(ids) ? ids : [ids]).map(String));
    let added = 0;
    const profiles = getProfiles().map(profile => {
      if (!selected.has(String(profile.id))) return profile;
      const groups = groupsForProfile(profile);
      if (groups.some(value => value.toLowerCase() === cleanGroup.toLowerCase())) return profile;
      added += 1;
      const next = { ...profile, groups: [...groups, cleanGroup] };
      delete next.group;
      return next;
    });
    if (added) writeProfiles(profiles);
    registerProfileGroups([cleanGroup]);
    return added;
  }

  function removeProfilesFromGroup(ids, group) {
    const cleanGroup = String(group || '').trim();
    const selected = new Set((Array.isArray(ids) ? ids : [ids]).map(String));
    writeProfiles(getProfiles().map(profile => {
      if (!selected.has(String(profile.id))) return profile;
      const next = {
        ...profile,
        groups: groupsForProfile(profile)
          .filter(value => value.toLowerCase() !== cleanGroup.toLowerCase()),
      };
      delete next.group;
      return next;
    }));
  }

  function setProfileGroups(id, groups) {
    const clean = normalizeProfileGroups(groups);
    updateProfile(id, { groups: clean });
    registerProfileGroups(clean);
  }

  function importProfiles(incoming, mode) {
    const arriving = Array.isArray(incoming) ? incoming : [];
    if (mode === 'replace') {
      writeProfiles(arriving);
      registerProfileGroups(arriving.flatMap(groupsForProfile));
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
    if (added) {
      writeProfiles(current);
      registerProfileGroups(arriving.flatMap(groupsForProfile));
    }
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
    createProfileGroup,
    renameProfileGroup,
    deleteProfileGroup,
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
    paymentMigrationVersion: PROFILE_PAYMENT_MIGRATION_VERSION,
    getProfiles,
    getProfileImap,
    getGroups,
    createProfileGroup,
    renameProfileGroup,
    deleteProfileGroup,
    importProfiles,
    normalizeImapConfig,
    profilePath: filePath(PROFILE_FILE),
    settingsPath: filePath(SETTINGS_FILE),
  });
}

module.exports = {
  PROFILE_IMAP_MIGRATION_VERSION,
  PROFILE_PAYMENT_MIGRATION_VERSION,
  createProfileImapControl,
};
