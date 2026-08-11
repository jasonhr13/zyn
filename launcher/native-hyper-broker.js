'use strict';

const contract = require('./native-engine-contract');

let authority = null;
const pending = new Map();

function setAuthority(next) {
  if (!next || typeof next.hyper !== 'function') throw new Error('native Hyper broker requires a license authority');
  authority = next;
}

function responseIdentity(message, registry) {
  const requestId = String(message && message.requestId || '').trim();
  const taskId = contract.taskIdOf(message);
  const explicitSite = contract.canonicalSite(message && message.site, { required: false });
  const registeredSite = registry && taskId ? registry.resolve({ taskId }) : '';
  return { requestId, taskId, site: explicitSite || registeredSite };
}

function sendResult(message, result, { registry, send, isActive = () => true }) {
  if (!isActive()) return false;
  const identity = responseIdentity(message, registry);
  if (!identity.requestId || !identity.taskId || !identity.site) return false;
  const envelope = contract.buildHyperResponse({
    ...identity,
    ok: result && result.ok === true,
    status: Number(result && result.status) || 0,
    body: String(result && result.body || ''),
    error: String(result && result.error || ''),
  });
  return send(envelope) !== false;
}

async function handleRequest(message, options = {}) {
  const { registry, logger = console } = options;
  let request;
  try {
    request = contract.buildHyperRequest(message).messages[0];
  } catch (error) {
    logger.warn?.(`[hyper] rejected engine request: ${error.message}`);
    return sendResult(message, { ok: false, status: 400, error: 'Invalid Hyper request.' }, options);
  }

  const registeredSite = registry && registry.resolve({ taskId: request.taskId });
  if (request.site !== contract.SITES.POKEMON_CENTER_US
      || registeredSite !== contract.SITES.POKEMON_CENTER_US) {
    return sendResult(request, {
      ok: false,
      status: 403,
      error: 'Hyper requests require an active Pokémon Center task.',
    }, options);
  }
  if (!authority) {
    return sendResult(request, { ok: false, status: 503, error: 'Hyper broker is not available.' }, options);
  }
  if (pending.has(request.requestId)) {
    return sendResult(request, { ok: false, status: 409, error: 'Duplicate Hyper request identifier.' }, options);
  }

  const marker = { canceled: false };
  pending.set(request.requestId, marker);
  try {
    const result = await authority.hyper(request.operation, request.payload);
    if (marker.canceled) return false;
    return sendResult(request, result, options);
  } catch (error) {
    logger.warn?.(`[hyper] broker request failed: ${error.message}`);
    if (marker.canceled) return false;
    return sendResult(request, { ok: false, status: 502, error: 'Hyper service is unavailable.' }, options);
  } finally {
    if (pending.get(request.requestId) === marker) pending.delete(request.requestId);
  }
}

async function handleEnvelope(envelope, options = {}) {
  const parsed = contract.parseEnvelope(envelope);
  if (parsed.type !== 'hyper-request') return false;
  await Promise.all(parsed.messages.map(message => handleRequest(message, options)));
  return true;
}

function cancelPending() {
  for (const marker of pending.values()) marker.canceled = true;
  pending.clear();
}

module.exports = {
  setAuthority,
  handleEnvelope,
  cancelPending,
  __test: { handleRequest, pendingCount: () => pending.size },
};
