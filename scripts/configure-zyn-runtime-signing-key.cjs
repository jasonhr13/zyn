#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const { execFileSync } = require('child_process');

const keychainService = 'com.thwebco.zyn.runtime-signing';
const keychainAccount = 'manifest-private-key';

function findPrivateKey() {
  try {
    return execFileSync('security', [
      'find-generic-password', '-a', keychainAccount, '-s', keychainService, '-w',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

let privateKeyValue = findPrivateKey();
let created = false;
if (!privateKeyValue) {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  privateKeyValue = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');

  // `security add-generic-password -w` prompts twice even when stdin is piped and can exit without
  // persisting the item. execFile bypasses a shell and the secret is never printed; verify the
  // exact value by reading it back immediately before reporting success.
  execFileSync('security', [
    'add-generic-password', '-U',
    '-a', keychainAccount,
    '-s', keychainService,
    '-l', 'Zyn runtime manifest signing key',
    '-w', privateKeyValue,
  ], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const storedValue = findPrivateKey();
  const stored = Buffer.from(storedValue);
  const expected = Buffer.from(privateKeyValue);
  if (!storedValue || stored.length !== expected.length || !crypto.timingSafeEqual(stored, expected)) {
    throw new Error('The Zyn runtime signing key could not be verified after writing it to the login Keychain.');
  }
  created = true;
}

let privateKey;
try {
  privateKey = crypto.createPrivateKey({
    key: Buffer.from(privateKeyValue, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
} catch {
  throw new Error(`Keychain item ${keychainService}/${keychainAccount} is not a valid PKCS#8 Ed25519 key.`);
}

if (privateKey.asymmetricKeyType !== 'ed25519') {
  throw new Error(`Keychain item ${keychainService}/${keychainAccount} is not an Ed25519 key.`);
}

const publicKey = crypto.createPublicKey(privateKey);
const publicDer = publicKey.export({ type: 'spki', format: 'der' });
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).trim();
const fingerprint = crypto.createHash('sha256').update(publicDer).digest('hex');

console.log(created
  ? 'Created the Zyn runtime manifest signing key in the login Keychain.'
  : 'Using the existing Zyn runtime manifest signing key in the login Keychain.');
console.log(`Service: ${keychainService}`);
console.log(`Account: ${keychainAccount}`);
console.log(`Public key SHA-256: ${fingerprint}`);
console.log(publicPem);
