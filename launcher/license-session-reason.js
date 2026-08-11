'use strict';

const SESSION_REASON_BY_CODE = Object.freeze({
  account_disabled: 'This account has been disabled. Contact support if you think this is a mistake.',
  session_replaced: 'You were signed out because another sign-in replaced this session. Sign in again to use Zyn here.',
  session_limit_reduced: 'You were signed out because an administrator reduced this account\u2019s active-device limit. Sign in again or contact support if this was unexpected.',
  password_changed: 'Your password was changed, so this device was signed out. Sign in again with your current password.',
  session_revoked: 'This Zyn session was revoked by an administrator. Sign in again or contact support if this was unexpected.',
  signed_out: 'You are signed out. Sign in again to continue.',
  session_expired: 'Your Zyn session expired. Sign in again to continue.',
  session_device_mismatch: 'This saved session belongs to a different device. Sign in again to continue.',
  session_invalid: 'Your Zyn session is no longer valid. Sign in again to continue.',
  // Compatibility with license-service versions that did not expose the session-end cause.
  license_invalid: 'Your Zyn session is no longer valid. Sign in again to continue.',
});

function invalidSessionReason(result, fallback = SESSION_REASON_BY_CODE.session_invalid) {
  const code = String(result && result.code || '');
  if (SESSION_REASON_BY_CODE[code]) return SESSION_REASON_BY_CODE[code];
  return String(result && result.message || fallback).slice(0, 240);
}

module.exports = { SESSION_REASON_BY_CODE, invalidSessionReason };
