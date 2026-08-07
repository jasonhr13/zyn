#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLicenseObserver } = require('../launcher/license-observer');

const roots = [];
const temporary = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hope-license-observer-'));
  roots.push(root);
  return root;
};

const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(`sealed:${value}`, 'utf8'),
  decryptString: value => {
    const text = value.toString('utf8');
    if (!text.startsWith('sealed:')) throw new Error('bad test ciphertext');
    return text.slice('sealed:'.length);
  },
};

const calls = [];
const api = {
  async login(email, password) {
    calls.push({ method: 'login', email, password });
    return {
      ok: true,
      licenseToken: 'super-secret-bearer',
      email,
      expiresAt: 999999,
      taskTypes: { pokemoncenter: true, round1: false },
      proxyAccess: true,
      proxyListCount: 2,
      managedProxyLists: [{ name: 'must-not-cross-ipc', raw: 'user:password@proxy' }],
    };
  },
  async validate(token, revision) {
    calls.push({ method: 'validate', token, revision });
    return {
      ok: true,
      email: 'operator@example.com',
      expiresAt: 1999999,
      taskTypes: { pokemoncenter: false, round1: true },
      proxyAccess: false,
      proxyListCount: 0,
    };
  },
  async logout(token) { calls.push({ method: 'logout', token }); return { ok: true }; },
  async resetPassword() { throw new Error('unexpected reset'); },
};

(async () => {
  try {
    const root = temporary();
    const observer = createLicenseObserver({ dataDirectory: root, safeStorage: fakeSafeStorage, api, now: () => 123456 });
    const initial = observer.status();
    assert.equal(initial.mode, 'observe');
    assert.equal(initial.enforcing, false);
    assert.equal(initial.signedIn, false);
    assert.equal(initial.valid, null);

    const signedIn = await observer.login({ email: ' OPERATOR@EXAMPLE.COM ', password: 'login-password' });
    assert.equal(signedIn.signedIn, true);
    assert.equal(signedIn.valid, true);
    assert.equal(signedIn.email, 'operator@example.com');
    assert.equal(signedIn.storage, 'encrypted');
    assert.equal(signedIn.managedProxyCount, 2);
    assert.deepEqual(signedIn.taskTypes, { pokemoncenter: true, round1: false });
    const rendererJson = JSON.stringify(signedIn);
    for (const secret of ['super-secret-bearer', 'login-password', 'must-not-cross-ipc', 'user:password@proxy']) {
      assert.equal(rendererJson.includes(secret), false, `renderer status leaked ${secret}`);
    }

    const stored = fs.readFileSync(observer.sessionPath, 'utf8');
    assert.equal(stored.includes('super-secret-bearer'), false, 'session persisted a plaintext bearer token');
    assert.equal(stored.includes('login-password'), false, 'session persisted a password');
    assert.equal(stored.includes('user:password@proxy'), false, 'session persisted managed proxy credentials');
    assert.equal(fs.statSync(observer.sessionPath).mode & 0o777, 0o600, 'session permissions are not owner-only');

    const restoredObserver = createLicenseObserver({ dataDirectory: root, safeStorage: fakeSafeStorage, api, now: () => 223456 });
    const restored = restoredObserver.status();
    assert.equal(restored.signedIn, true);
    assert.equal(restored.valid, null, 'restored state was treated as validated without a server check');
    const refreshed = await restoredObserver.refresh();
    assert.equal(refreshed.valid, true);
    assert.equal(refreshed.proxyAccess, false);
    assert.equal(calls.find(call => call.method === 'validate').token, 'super-secret-bearer');
    await restoredObserver.logout();
    assert.equal(calls.find(call => call.method === 'logout').token, 'super-secret-bearer');
    assert.deepEqual(JSON.parse(fs.readFileSync(observer.sessionPath, 'utf8')), {});

    let suppliedResetToken = '';
    const resetObserver = createLicenseObserver({
      dataDirectory: temporary(),
      safeStorage: fakeSafeStorage,
      now: () => 323456,
      api: {
        async login() {
          return { ok: false, status: 403, code: 'password_reset_required', message: 'Choose a password.', resetToken: 'main-only-reset-token', email: 'reset@example.com' };
        },
        async resetPassword(resetToken, newPassword) {
          suppliedResetToken = resetToken;
          assert.equal(newPassword, 'new-password-123');
          return { ok: true, licenseToken: 'post-reset-bearer', email: 'reset@example.com', expiresAt: 888888 };
        },
      },
    });
    const resetRequired = await resetObserver.login({ email: 'reset@example.com', password: 'temporary-password' });
    assert.equal(resetRequired.requiresPasswordReset, true);
    assert.equal(JSON.stringify(resetRequired).includes('main-only-reset-token'), false, 'reset token crossed into renderer status');
    const resetComplete = await resetObserver.reset({ newPassword: 'new-password-123', resetToken: 'renderer-injected-token' });
    assert.equal(suppliedResetToken, 'main-only-reset-token', 'observer trusted a renderer-supplied reset token');
    assert.equal(resetComplete.valid, true);

    const memoryRoot = temporary();
    const memoryObserver = createLicenseObserver({
      dataDirectory: memoryRoot,
      safeStorage: { isEncryptionAvailable: () => false },
      api: { async login() { return { ok: true, licenseToken: 'memory-token', email: 'memory@example.com' }; } },
    });
    const memoryStatus = await memoryObserver.login({ email: 'memory@example.com', password: 'password' });
    assert.equal(memoryStatus.storage, 'memory');
    assert.equal(fs.existsSync(memoryObserver.sessionPath), false, 'unencrypted token was persisted');

    const networkObserver = createLicenseObserver({
      dataDirectory: temporary(),
      safeStorage: fakeSafeStorage,
      api: { async login() { throw new Error('offline'); } },
      logger: { warn() {} },
    });
    const offline = await networkObserver.login({ email: 'offline@example.com', password: 'password' });
    assert.equal(offline.enforcing, false);
    assert.match(offline.reason, /current R3 app session is unaffected/i);

    console.log(JSON.stringify({
      ok: true,
      mode: signedIn.mode,
      enforcing: signedIn.enforcing,
      tokenRendererSafe: true,
      resetTokenMainOnly: true,
      storage: signedIn.storage,
      permissions: '0600',
      restoredAndValidated: refreshed.valid,
      memoryFallbackPersisted: false,
    }, null, 2));
  } finally {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
