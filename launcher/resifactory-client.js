'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

const DEFAULT_API_BASE = 'https://resifactory.net/api/v1';
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30000;
const KEY_PATTERN = /^rf_live_[A-Za-z0-9_-]{6,}$/;

const USER_MESSAGES = Object.freeze({
  unauthorized: 'That API key is invalid or has been revoked.',
  account_disabled: 'This ResiFactory account is suspended.',
  insufficient_scope: 'This key does not have permission for that action. Create a new key in ResiFactory → Developer with the needed scopes.',
  not_found: 'ResiFactory could not find that resource.',
  pool_not_available: 'That pool is not available on this ResiFactory account.',
  invalid_request: 'ResiFactory rejected the request.',
  invalid_params: 'One or more fields are invalid.',
  rate_limited: 'ResiFactory rate-limited this request. Try again in a moment.',
  idempotency_key_reuse: 'That request was retried with different details. Start it again.',
  idempotency_in_progress: 'That request is still running. Wait a moment and try again.',
  spend_cap_exceeded: 'This key has no monthly spend cap, or the top-up would exceed it. Create a new key in ResiFactory → Developer with Billing enabled and a monthly cap.',
  card_not_available: 'Saved-card charges are not available on this account. Pay through the checkout page instead.',
  payment_failed: 'ResiFactory could not complete the payment.',
  conversion_not_allowed: 'That pool cannot receive a conversion on this account.',
  internal_error: 'ResiFactory had a server error. Try again.',
});

class ResiFactoryError extends Error {
  constructor(message, { code = '', status = 0, requestId = '', retryAfter = 0 } = {}) {
    super(message);
    this.name = 'ResiFactoryError';
    this.code = code;
    this.status = status;
    this.requestId = requestId;
    this.retryAfter = retryAfter;
  }
}

function normalizeKey(value) {
  return String(value || '')
    .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '')
    .replace(/^[\s"']+|[\s"']+$/g, '')
    .replace(/^Bearer\s+/i, '')
    .replace(/\s+/g, '');
}

function validApiKey(value) {
  return KEY_PATTERN.test(normalizeKey(value));
}

function userMessage(code, fallback) {
  return USER_MESSAGES[code] || String(fallback || 'ResiFactory request failed.');
}

function headerValue(headers, name) {
  const wanted = String(name || '').toLowerCase();
  const source = headers && typeof headers === 'object' ? headers : {};
  for (const [key, value] of Object.entries(source)) {
    if (String(key).toLowerCase() === wanted) {
      return Array.isArray(value) ? String(value[0] || '') : String(value || '');
    }
  }
  return '';
}

function parseRetryAfter(headers) {
  const raw = headerValue(headers, 'retry-after');
  const seconds = Number.parseInt(raw, 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

function defaultRequest({ method, url, headers, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let target;
    try { target = new URL(url); }
    catch {
      reject(new ResiFactoryError('ResiFactory URL is invalid.'));
      return;
    }
    if (!['https:', 'http:'].includes(target.protocol)) {
      reject(new ResiFactoryError('ResiFactory URL must be HTTPS.'));
      return;
    }
    const payload = body == null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const transport = target.protocol === 'https:' ? https : http;
    const request = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method,
      headers: {
        accept: 'application/json',
        'rf-strict': '1',
        ...(payload ? {
          'content-type': 'application/json',
          'content-length': payload.length,
        } : {}),
        ...headers,
      },
    }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on('data', (chunk) => {
        const part = Buffer.from(chunk);
        chunks.push(part);
        bytes += part.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          response.destroy(new ResiFactoryError('ResiFactory response was unexpectedly large.'));
        }
      });
      response.on('error', reject);
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = {};
        if (raw) {
          try { parsed = JSON.parse(raw); }
          catch {
            resolve({
              status: response.statusCode || 0,
              headers: response.headers || {},
              body: { error: { code: 'invalid_response', message: 'ResiFactory returned a non-JSON response.' } },
            });
            return;
          }
        }
        resolve({
          status: response.statusCode || 0,
          headers: response.headers || {},
          body: parsed && typeof parsed === 'object' ? parsed : {},
        });
      });
    });
    request.on('error', (error) => {
      reject(new ResiFactoryError(error && error.message ? error.message : 'Could not reach ResiFactory.'));
    });
    request.setTimeout(timeoutMs || REQUEST_TIMEOUT_MS, () => {
      request.destroy(new ResiFactoryError('ResiFactory request timed out.'));
    });
    if (payload) request.write(payload);
    request.end();
  });
}

function raiseFromResponse(response) {
  const body = response && response.body && typeof response.body === 'object' ? response.body : {};
  const error = body.error && typeof body.error === 'object' ? body.error : {};
  const code = String(error.code || (response.status === 401 ? 'unauthorized' : '') || '');
  const requestId = String(error.request_id || headerValue(response.headers, 'x-request-id') || '');
  const retryAfter = parseRetryAfter(response.headers);
  const detail = Array.isArray(error.details) && error.details[0] && error.details[0].field
    ? ` (${error.details[0].field})`
    : '';
  throw new ResiFactoryError(`${userMessage(code, error.message)}${detail}`, {
    code,
    status: response.status || 0,
    requestId,
    retryAfter,
  });
}

function createResiFactoryClient({
  apiBase = DEFAULT_API_BASE,
  request = defaultRequest,
} = {}) {
  const root = String(apiBase || DEFAULT_API_BASE).replace(/\/$/, '');

  async function call(apiKey, method, pathname, { body, idempotencyKey } = {}) {
    const key = normalizeKey(apiKey);
    if (!validApiKey(key)) {
      throw new ResiFactoryError('Enter a ResiFactory API key that starts with rf_live_.');
    }
    const headers = { authorization: `Bearer ${key}` };
    if (idempotencyKey) headers['idempotency-key'] = String(idempotencyKey);
    const response = await request({
      method,
      url: `${root}${pathname}`,
      headers,
      body,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    if (!response || response.status < 200 || response.status >= 300) raiseFromResponse(response || {});
    return response.body || {};
  }

  return {
    me(apiKey) { return call(apiKey, 'GET', '/me'); },
    pools(apiKey) { return call(apiKey, 'GET', '/pools'); },
    balance(apiKey) { return call(apiKey, 'GET', '/balance'); },
    generate(apiKey, body, idempotencyKey) {
      return call(apiKey, 'POST', '/proxies', { body, idempotencyKey });
    },
    startTopup(apiKey, body, idempotencyKey) {
      return call(apiKey, 'POST', '/billing/topups', { body, idempotencyKey });
    },
    getTopup(apiKey, id) {
      return call(apiKey, 'GET', `/billing/topups/${encodeURIComponent(String(id))}`);
    },
  };
}

module.exports = {
  DEFAULT_API_BASE,
  KEY_PATTERN,
  ResiFactoryError,
  createResiFactoryClient,
  normalizeKey,
  validApiKey,
  userMessage,
};
