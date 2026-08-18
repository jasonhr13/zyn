#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createLicenseAuthority,
  LICENSE_CHECK_MS,
  LICENSE_OFFLINE_GRACE_MS,
} = require('../launcher/license-authority');
const { invalidSessionReason } = require('../launcher/license-session-reason');

const roots = [];
const temporary = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zyn-license-authority-'));
  roots.push(root);
  return root;
};
const encrypted = value => `enc:${Buffer.from(`sealed:${value}`, 'utf8').toString('base64')}`;
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(`sealed:${value}`, 'utf8'),
  decryptString: value => {
    const text = value.toString('utf8');
    if (!text.startsWith('sealed:')) throw new Error('invalid test ciphertext');
    return text.slice('sealed:'.length);
  },
};
const silentLogger = { warn() {} };

(async () => {
  try {
    let now = 1_000_000;
    const calls = [];
    let intervalCallback = null;
    let intervalDelay = 0;
    let canceledTimer = null;
    const entitlementChanges = [];
    const managedEvents = [];
    const proxyRevision = 'a'.repeat(64);
    const accountId = '11111111-1111-4111-8111-111111111111';
    const api = {
      async login(email, password) {
        calls.push({ method: 'login', email, password });
        return {
          ok: true,
          licenseToken: 'authoritative-bearer',
          userId: accountId,
          email,
          expiresAt: now + 30 * 24 * 60 * 60 * 1000,
          taskTypes: { pokemoncenter: true, round1: false },
          billingPlan: 'zyn-standard',
          billingStatus: 'trialing',
          accessUntil: now + 60 * 24 * 60 * 60 * 1000,
          proxyAccess: true,
          proxyListCount: 3,
          proxyRevision,
          proxyListsChanged: true,
          managedProxyLists: [{ raw: 'proxy-secret' }],
        };
      },
      async validate(token, revision) {
        calls.push({ method: 'validate', token, revision });
        return {
          ok: true, userId: accountId, email: 'owner@example.com', expiresAt: now + 5000,
          taskTypes: { round1: true }, proxyAccess: true, proxyListCount: 3,
          proxyRevision, proxyListsChanged: false,
        };
      },
      async hyper(token, operation, payload) {
        calls.push({ method: 'hyper', token, operation, payload });
        return { ok: true, status: 200, body: '{"solution":"safe"}' };
      },
      async listBackups(token) {
        calls.push({ method: 'listBackups', token });
        return { ok: true, backups: [{ id: '11111111-1111-4111-8111-111111111111' }] };
      },
      async uploadBackup(token, buffer, metadata) {
        calls.push({ method: 'uploadBackup', token, bytes: buffer.length, metadata });
        return { ok: true, backup: { id: metadata.backupId } };
      },
      async downloadBackup(token, backupId) {
        calls.push({ method: 'downloadBackup', token, backupId });
        return { ok: true, buffer: Buffer.from('encrypted-test'), headers: { 'x-rcart-backup-sha256': 'a'.repeat(64) } };
      },
      async deleteBackup(token, backupId) {
        calls.push({ method: 'deleteBackup', token, backupId });
        return { ok: true };
      },
      queueEvents(token, handlers) {
        calls.push({ method: 'queueEvents', token, handlers });
        return { close() {} };
      },
      async logout(token) { calls.push({ method: 'logout', token }); return { ok: true }; },
      async resetPassword() { throw new Error('unexpected reset'); },
    };
    const root = temporary();
    let lockCount = 0;
    const statuses = [];
    const authority = createLicenseAuthority({
      dataDirectory: root,
      safeStorage,
      api,
      now: () => now,
      onStatus: status => statuses.push(status),
      onLock: () => { lockCount += 1; },
      onEntitlementsChanged: change => entitlementChanges.push(change),
      onManagedProxies: result => {
        managedEvents.push(result);
        return result.proxyAccess === true
          ? { count: Number(result.proxyListCount) || 3, revision: result.proxyRevision }
          : { count: 0, revision: '' };
      },
      scheduleInterval: (callback, delay) => { intervalCallback = callback; intervalDelay = delay; return 44; },
      cancelInterval: id => { canceledTimer = id; },
      logger: silentLogger,
    });

    assert.equal((await authority.status()).ok, false);
    const signedIn = await authority.login({ email: ' OWNER@EXAMPLE.COM ', password: 'account-password' });
    assert.equal(signedIn.ok, true);
    assert.equal(signedIn.email, 'owner@example.com');
    assert.equal(signedIn.storage, 'encrypted');
    assert.equal(signedIn.managedProxyCount, 3);
    assert.equal(signedIn.userId, undefined, 'stable account identifier leaked to renderer status');
    assert.equal(authority.backupAccountId(), accountId);
    assert.deepEqual(signedIn.taskTypes, { pokemoncenter: true, round1: false });
    assert.equal(signedIn.billingPlan, 'zyn-standard');
    assert.equal(signedIn.billingStatus, 'trialing');
    assert.equal(signedIn.accessUntil, now + 60 * 24 * 60 * 60 * 1000);
    const rendererJson = JSON.stringify(signedIn);
    for (const secret of ['authoritative-bearer', 'account-password', 'proxy-secret']) {
      assert.equal(rendererJson.includes(secret), false, `renderer status leaked ${secret}`);
    }
    const stored = fs.readFileSync(authority.sessionPath, 'utf8');
    assert.equal(stored.includes('authoritative-bearer'), false, 'bearer token was persisted in plaintext');
    assert.equal(stored.includes('account-password'), false, 'password was persisted');
    assert.equal(stored.includes('proxy-secret'), false, 'managed proxy credential was persisted');
    assert.equal(fs.statSync(authority.sessionPath).mode & 0o777, 0o600);
    const hyper = await authority.hyper('reese84', { pageUrl: 'https://www.pokemoncenter.com/' });
    assert.deepEqual(hyper, { ok: true, status: 200, body: '{"solution":"safe"}', error: '' });
    assert.deepEqual(calls.find(call => call.method === 'hyper'), {
      method: 'hyper',
      token: 'authoritative-bearer',
      operation: 'reese84',
      payload: { pageUrl: 'https://www.pokemoncenter.com/' },
    });
    assert.equal(JSON.stringify(hyper).includes('authoritative-bearer'), false);
    const backupId = '22222222-2222-4222-8222-222222222222';
    const listedBackups = await authority.listBackups(accountId);
    const uploadedBackup = await authority.uploadBackup(Buffer.from('ciphertext'), { backupId }, accountId);
    const downloadedBackup = await authority.downloadBackup(backupId, accountId);
    const deletedBackup = await authority.deleteBackup(backupId, accountId);
    assert.equal(listedBackups.ok, true);
    assert.equal(uploadedBackup.ok, true);
    assert.equal(downloadedBackup.buffer.toString(), 'encrypted-test');
    assert.equal(deletedBackup.ok, true);
    for (const method of ['listBackups', 'uploadBackup', 'downloadBackup', 'deleteBackup']) {
      assert.equal(calls.find(call => call.method === method).token, 'authoritative-bearer');
    }
    assert.equal(calls.find(call => call.method === 'uploadBackup').bytes, 10);
    assert.equal(JSON.stringify({ listedBackups, uploadedBackup, deletedBackup }).includes('authoritative-bearer'), false,
      'backup authority leaked its bearer token');
    assert.equal((await authority.listBackups('33333333-3333-4333-8333-333333333333')).status, 409,
      'backup authority did not bind an operation to the initiating account');
    const queueSocket = authority.openPokemonQueueEvents({ message() {} });
    assert.equal(typeof queueSocket.close, 'function');
    assert.equal(calls.find(call => call.method === 'queueEvents').token, 'authoritative-bearer');
    const refreshed = await authority.validate();
    assert.equal(calls.find(call => call.method === 'validate').revision, proxyRevision);
    assert.equal(managedEvents.some(result => JSON.stringify(result.managedProxyLists || []).includes('proxy-secret')), true);
    assert.deepEqual(refreshed.taskTypes, { pokemoncenter: false, round1: true });
    assert.deepEqual(entitlementChanges, [{
      removed: ['pokemoncenter'],
      previous: { pokemoncenter: true, round1: false },
      next: { pokemoncenter: false, round1: true },
    }]);
    const deniedHyper = await authority.hyper('reese84', {});
    assert.equal(deniedHyper.status, 403);
    assert.equal(calls.filter(call => call.method === 'hyper').length, 1,
      'removed Pokémon Center entitlement still reached the Hyper service');
    assert.throws(() => authority.openPokemonQueueEvents({}), /not enabled/);
    assert.equal(calls.filter(call => call.method === 'queueEvents').length, 1,
      'removed Pokémon Center entitlement still reached the queue event stream');
    authority.start();
    authority.start();
    assert.equal(intervalDelay, LICENSE_CHECK_MS);
    assert.equal(typeof intervalCallback, 'function');
    authority.dispose();
    assert.equal(canceledTimer, 44);
    assert.equal(lockCount, 0);

    const restored = createLicenseAuthority({ dataDirectory: root, safeStorage, api, now: () => now, logger: silentLogger });
    const restoredStatus = await restored.status();
    assert.equal(restoredStatus.ok, true);
    assert.equal(calls.find(call => call.method === 'validate').token, 'authoritative-bearer');

    const invalidRoot = temporary();
    let invalidLocks = 0;
    let invalidMode = false;
    const invalidApi = {
      async login() { return { ok: true, licenseToken: 'revoked-bearer', email: 'revoked@example.com' }; },
      async validate() { return invalidMode
        ? { ok: false, status: 401, code: 'session_replaced' }
        : { ok: true, email: 'revoked@example.com' }; },
    };
    const invalidAuthority = createLicenseAuthority({
      dataDirectory: invalidRoot, safeStorage, api: invalidApi, now: () => now,
      onLock: () => { invalidLocks += 1; }, logger: silentLogger,
    });
    await invalidAuthority.login({ email: 'revoked@example.com', password: 'password' });
    invalidMode = true;
    const invalid = await invalidAuthority.validate();
    assert.equal(invalid.ok, false);
    assert.match(invalid.reason, /another sign-in/i);
    assert.match(invalid.reason, /replaced this session/i);
    assert.doesNotMatch(invalid.reason, /revoked/i);
    assert.equal(invalidLocks, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(invalidAuthority.sessionPath, 'utf8')), {});
    assert.match(invalidSessionReason({ code: 'session_limit_reduced' }), /administrator reduced/i);
    assert.match(invalidSessionReason({ code: 'session_limit_reduced' }), /active-device limit/i);
    assert.match(invalidSessionReason({ code: 'session_revoked' }), /revoked by an administrator/i);
    assert.match(invalidSessionReason({ code: 'license_invalid' }), /sign in again/i);
    assert.match(invalidSessionReason({ code: 'subscription_expired' }), /subscription has ended/i);
    assert.doesNotMatch(invalidSessionReason({ code: 'license_invalid' }), /revoked/i);

    const graceRoot = temporary();
    let graceLocks = 0;
    const graceApi = {
      async login() { return { ok: true, licenseToken: 'offline-bearer', email: 'offline@example.com' }; },
      async validate() { throw new Error('offline'); },
    };
    const graceAuthority = createLicenseAuthority({
      dataDirectory: graceRoot, safeStorage, api: graceApi, now: () => now,
      onLock: () => { graceLocks += 1; }, logger: silentLogger,
    });
    await graceAuthority.login({ email: 'offline@example.com', password: 'password' });
    now += LICENSE_OFFLINE_GRACE_MS - 1;
    const withinGrace = await graceAuthority.validate();
    assert.equal(withinGrace.ok, true);
    assert.equal(withinGrace.offline, true);
    assert.equal(graceLocks, 0);
    now += 2;
    const beyondGrace = await graceAuthority.validate();
    assert.equal(beyondGrace.ok, false);
    assert.equal(graceLocks, 1);
    assert.equal(beyondGrace.storage, 'encrypted', 'transient outage discarded the retryable token');

    let serverResetToken = '';
    const resetAuthority = createLicenseAuthority({
      dataDirectory: temporary(), safeStorage, now: () => now, logger: silentLogger,
      api: {
        async login() {
          return { ok: false, status: 403, code: 'password_reset_required', message: 'Choose a password.', resetToken: 'main-only-reset', email: 'reset@example.com' };
        },
        async resetPassword(resetToken, password) {
          serverResetToken = resetToken;
          assert.equal(password, 'replacement-password');
          return { ok: true, licenseToken: 'reset-bearer', email: 'reset@example.com' };
        },
      },
    });
    const resetRequired = await resetAuthority.login({ email: 'reset@example.com', password: 'temporary-password' });
    assert.equal(resetRequired.requiresPasswordReset, true);
    assert.equal(JSON.stringify(resetRequired).includes('main-only-reset'), false);
    const resetDone = await resetAuthority.reset({ newPassword: 'replacement-password', resetToken: 'renderer-injection' });
    assert.equal(resetDone.ok, true);
    assert.equal(serverResetToken, 'main-only-reset');

    const migrationRoot = temporary();
    fs.writeFileSync(path.join(migrationRoot, 'license-observer-session.json'), JSON.stringify({
      email: 'migrated@example.com', token: encrypted('observer-bearer'), validatedAt: now, taskTypes: { round1: true },
    }), { mode: 0o600 });
    let migratedToken = '';
    const migrationAuthority = createLicenseAuthority({
      dataDirectory: migrationRoot, safeStorage, now: () => now, logger: silentLogger,
      api: { async validate(token) { migratedToken = token; return { ok: true, email: 'migrated@example.com' }; } },
    });
    assert.equal((await migrationAuthority.status()).ok, true);
    assert.equal(migratedToken, 'observer-bearer');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(migrationRoot, 'license-observer-session.json'), 'utf8')), {});
    assert.equal(fs.existsSync(migrationAuthority.sessionPath), true);

    let logoutLocks = 0;
    const logoutRoot = temporary();
    let logoutToken = '';
    const logoutAuthority = createLicenseAuthority({
      dataDirectory: logoutRoot, safeStorage, now: () => now, logger: silentLogger,
      onLock: () => { logoutLocks += 1; },
      api: {
        async login() { return { ok: true, licenseToken: 'logout-bearer', email: 'logout@example.com' }; },
        async logout(token) { logoutToken = token; return { ok: true }; },
      },
    });
    await logoutAuthority.login({ email: 'logout@example.com', password: 'password' });
    const loggedOut = await logoutAuthority.logout();
    assert.equal(loggedOut.ok, false);
    assert.equal(logoutToken, 'logout-bearer');
    assert.equal(logoutLocks, 1);
    assert.equal((await logoutAuthority.listBackups()).status, 401);

    assert.ok(statuses.length >= 1);
    console.log(JSON.stringify({
      ok: true,
      authoritative: true,
      tokenRendererSafe: true,
      resetTokenMainOnly: true,
      persistedEncrypted: true,
      permissions: '0600',
      validationIntervalMs: LICENSE_CHECK_MS,
      offlineGraceMs: LICENSE_OFFLINE_GRACE_MS,
      revokedSessionLocked: invalidLocks === 1,
      removedEntitlementStopped: entitlementChanges[0].removed[0],
      observerSessionMigrated: true,
      logoutLocked: logoutLocks === 1,
      managedProxyRevisionReused: true,
      hyperBearerMainOnly: true,
      queueEventBearerMainOnly: true,
      backupBearerMainOnly: true,
    }, null, 2));
  } finally {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
