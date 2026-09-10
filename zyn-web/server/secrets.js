'use strict';

function decryptSecret(stored) {
  const value = String(stored == null ? '' : stored);
  if (!value) return '';
  try {
    if (value.startsWith('enc:')) {
      throw new Error('Electron safeStorage secrets cannot be read on Linux. Re-save accounts as b64: or import a desktop export.');
    }
    if (value.startsWith('b64:')) return Buffer.from(value.slice(4), 'base64').toString('utf8');
  } catch (error) {
    if (/safeStorage/.test(error.message)) throw error;
    return '';
  }
  return value;
}

function encryptSecret(plain) {
  const value = String(plain == null ? '' : plain);
  return value ? `b64:${Buffer.from(value, 'utf8').toString('base64')}` : '';
}

function decodeCookie(stored) {
  const value = String(stored == null ? '' : stored).trim();
  if (!value || value.startsWith('enc:')) return '';
  try {
    if (value.startsWith('b64:')) return decryptSecret(value);
  } catch {
    return '';
  }
  return value;
}

function accountCreds(account) {
  if (!account) return null;
  let password = '';
  try { password = decryptSecret(account.password); }
  catch { password = ''; }
  const cookie = decodeCookie(account.cookie);
  if (!password && !cookie) return null;
  return {
    email: account.email || '',
    password,
    cookie,
  };
}

module.exports = { decryptSecret, encryptSecret, decodeCookie, accountCreds };
