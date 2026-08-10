// Proxy bandwidth helpers for the Shape farmer. Keep Shape's JS/fingerprint surface intact:
// only drop bulk binary assets that Shape does not need to mint headers.

// Hope's existing control promises images, video, and fonts. Keep the upstream image/media policy
// and retain the recovered farmer's font block so moving to native does not regress proxy savings.
export const HEAVY_RESOURCE_TYPES = Object.freeze(['image', 'media', 'font']);

/** True when Playwright should abort this request to save proxy GB. Never blocks scripts. */
export function shouldBlockHeavyResource(resourceType) {
  return HEAVY_RESOURCE_TYPES.includes(String(resourceType || '').toLowerCase());
}

const nonNegative = value => Math.max(0, Number(value) || 0);

function headerBytes(headers) {
  return Object.entries(headers || {}).reduce((total, [name, value]) =>
    total + Buffer.byteLength(String(name)) + 2 + Buffer.byteLength(String(value)) + 2, 0);
}

/**
 * Chromium does not expose encoded upload length, so this is deliberately an estimate. Response
 * download bytes come from Network.loadingFinished.encodedDataLength and are wire-level values.
 */
export function estimateRequestBytes(request = {}) {
  const method = String(request.method || 'GET');
  const url = String(request.url || '');
  const body = request.postData == null ? '' : String(request.postData);
  return Buffer.byteLength(`${method} ${url} HTTP/1.1\r\n`)
    + headerBytes(request.headers)
    + 2
    + Buffer.byteLength(body);
}

export function emptyBandwidthSample(supported = true) {
  return {
    supported: supported === true,
    downloadBytes: 0,
    uploadBytes: 0,
    totalBytes: 0,
    requests: 0,
    blockedRequests: 0,
    cachedRequests: 0,
    failedRequests: 0,
  };
}

/**
 * Stateful CDP event accumulator, exported so the byte accounting can be tested without launching
 * a browser. Local route.fulfill responses and cache hits are intentionally excluded because they
 * do not traverse the configured proxy.
 */
export function createBandwidthAccumulator({ isLocalResponse = () => false } = {}) {
  const records = new Map();
  const totals = emptyBandwidthSample(true);

  const requestInfo = request => ({
    url: String(request && typeof request.url === 'function' ? request.url() : request && request.url || ''),
    method: String(request && typeof request.method === 'function' ? request.method() : request && request.method || ''),
    resourceType: String(request && typeof request.resourceType === 'function'
      ? request.resourceType() : request && (request.resourceType || request.type) || '').toLowerCase(),
  });
  const findPending = request => {
    const info = requestInfo(request);
    return [...records.values()].reverse().find(record => !record.finished
      && record.url === info.url && (!info.method || record.method === info.method));
  };
  const commitRequest = record => {
    if (!record || record.committed || record.local || record.blocked || record.cached) return;
    record.committed = true;
    totals.requests += 1;
    totals.uploadBytes += record.uploadBytes;
  };

  return {
    requestWillBeSent(event = {}) {
      const request = event.request || {};
      const redirect = records.get(String(event.requestId || ''));
      if (redirect && event.redirectResponse) {
        const cached = event.redirectResponse.fromDiskCache === true
          || event.redirectResponse.fromServiceWorker === true
          || event.redirectResponse.fromPrefetchCache === true;
        if (cached && !redirect.cached) {
          redirect.cached = true;
          totals.cachedRequests += 1;
        }
        commitRequest(redirect);
        if (redirect.committed) totals.downloadBytes += nonNegative(event.redirectResponse.encodedDataLength);
        redirect.finished = true;
      }
      const record = {
        id: String(event.requestId || ''),
        url: String(request.url || ''),
        method: String(request.method || 'GET'),
        resourceType: String(event.type || '').toLowerCase(),
        uploadBytes: estimateRequestBytes(request),
        local: false,
        blocked: false,
        cached: false,
        committed: false,
        finished: false,
      };
      record.local = !!isLocalResponse(record);
      records.set(record.id, record);
    },
    requestServedFromCache(event = {}) {
      const record = records.get(String(event.requestId || ''));
      if (record && !record.cached) {
        record.cached = true;
        totals.cachedRequests += 1;
      }
    },
    responseReceived(event = {}) {
      const record = records.get(String(event.requestId || ''));
      if (!record) return;
      const response = event.response || {};
      const cached = response.fromDiskCache === true || response.fromServiceWorker === true
        || response.fromPrefetchCache === true;
      if (cached && !record.cached) {
        record.cached = true;
        totals.cachedRequests += 1;
      }
      commitRequest(record);
    },
    loadingFinished(event = {}) {
      const record = records.get(String(event.requestId || ''));
      if (!record) return;
      commitRequest(record);
      if (record.committed) totals.downloadBytes += nonNegative(event.encodedDataLength);
      record.finished = true;
      records.delete(record.id);
    },
    loadingFailed(event = {}) {
      const record = records.get(String(event.requestId || ''));
      if (!record) return;
      commitRequest(record);
      if (record.committed) totals.failedRequests += 1;
      record.finished = true;
      records.delete(record.id);
    },
    noteBlocked(request) {
      const record = findPending(request);
      if (record) record.blocked = true;
      totals.blockedRequests += 1;
    },
    noteLocalResponse(request) {
      const record = findPending(request);
      if (record) record.local = true;
    },
    snapshot() {
      const downloadBytes = Math.round(totals.downloadBytes);
      const uploadBytes = Math.round(totals.uploadBytes);
      return {
        ...totals,
        downloadBytes,
        uploadBytes,
        totalBytes: downloadBytes + uploadBytes,
      };
    },
  };
}

/** Attach Chromium DevTools Network telemetry to one harvest page. */
export async function createPageBandwidthMeter(context, page, options = {}) {
  const accumulator = createBandwidthAccumulator(options);
  let session = null;
  let stopped = false;
  const handlers = {
    'Network.requestWillBeSent': event => accumulator.requestWillBeSent(event),
    'Network.requestServedFromCache': event => accumulator.requestServedFromCache(event),
    'Network.responseReceived': event => accumulator.responseReceived(event),
    'Network.loadingFinished': event => accumulator.loadingFinished(event),
    'Network.loadingFailed': event => accumulator.loadingFailed(event),
  };
  try {
    session = await context.newCDPSession(page);
    for (const [event, handler] of Object.entries(handlers)) session.on(event, handler);
    await session.send('Network.enable');
  } catch {
    try { await session?.detach(); } catch {}
    session = null;
  }

  return {
    supported: !!session,
    noteBlocked: request => accumulator.noteBlocked(request),
    noteLocalResponse: request => accumulator.noteLocalResponse(request),
    async stop() {
      if (!stopped) {
        stopped = true;
        if (session) {
          for (const [event, handler] of Object.entries(handlers)) session.off(event, handler);
          try { await session.send('Network.disable'); } catch {}
          try { await session.detach(); } catch {}
        }
      }
      return { ...accumulator.snapshot(), supported: !!session };
    },
  };
}

/**
 * Install a page.route filter that aborts image/media/font requests only.
 * Returns an uninstall function (best-effort).
 */
export async function installHeavyResourceBlock(page, { enabled = true, onBlocked = null } = {}) {
  if (!enabled || !page || typeof page.route !== 'function') return async () => {};
  const handler = (route) => {
    try {
      const request = route.request();
      const type = request.resourceType();
      if (shouldBlockHeavyResource(type)) {
        try { if (typeof onBlocked === 'function') onBlocked(request); } catch {}
        return route.abort();
      }
      return route.continue();
    } catch {
      try { return route.continue(); } catch { /* page closed */ }
    }
  };
  await page.route('**/*', handler);
  return async () => {
    try { await page.unroute('**/*', handler); } catch { /* ignore */ }
  };
}

export function blockHeavyResourcesEnabled(argValue) {
  // Default ON. Explicit false/0/off/no disables for yield debugging.
  const raw = String(argValue == null ? 'true' : argValue).trim().toLowerCase();
  if (raw === '' || raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on') return true;
  if (raw === 'false' || raw === '0' || raw === 'no' || raw === 'off') return false;
  return true;
}
