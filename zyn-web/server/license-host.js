'use strict';

const { createLicenseAuthority } = require('../../launcher/license-authority');

function fileSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: text => Buffer.from(String(text), 'utf8'),
    decryptString: buffer => Buffer.from(buffer).toString('utf8'),
  };
}

function createLicenseHost({ dataDirectory, logger = console, onStatus = () => {} } = {}) {
  const authority = createLicenseAuthority({
    dataDirectory,
    safeStorage: fileSafeStorage(),
    logger,
    onStatus,
  });
  return {
    authority,
    status: () => authority.cached(),
    refresh: () => authority.status({ force: true }),
    start: () => authority.start(),
    dispose: () => authority.dispose(),
    login: credentials => authority.login({
      email: credentials.email,
      password: credentials.password,
      sessionKind: 'engine',
    }),
    reset: payload => authority.reset({
      newPassword: payload.newPassword,
      sessionKind: 'engine',
    }),
    logout: () => authority.logout(),
  };
}

module.exports = { createLicenseHost, fileSafeStorage };
