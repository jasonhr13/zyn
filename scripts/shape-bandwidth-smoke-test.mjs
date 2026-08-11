#!/usr/bin/env node

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  createBandwidthAccumulator,
  createPageBandwidthMeter,
  estimateRequestBytes,
  installHeavyResourceBlock,
} from '../native-farmer/shape-bandwidth.mjs';
import {
  formatBandwidth,
  targetBandwidthSummary,
  targetHarvesterBandwidth,
} from '../frontend/src/components/target-bank-metrics.mjs';

const accumulator = createBandwidthAccumulator({
  isLocalResponse: request => request.url.includes('/locally-fulfilled'),
});
const normal = { method: 'GET', url: 'https://www.target.com/', headers: { accept: '*/*' } };
const failed = { method: 'POST', url: 'https://api.target.com/check', headers: { 'content-type': 'application/json' }, postData: '{"ok":true}' };

accumulator.requestWillBeSent({ requestId: 'normal', type: 'Document', request: normal });
accumulator.responseReceived({ requestId: 'normal', response: {} });
accumulator.loadingFinished({ requestId: 'normal', encodedDataLength: 2048 });

accumulator.requestWillBeSent({ requestId: 'cache', type: 'Script', request: { method: 'GET', url: 'https://www.target.com/cached.js' } });
accumulator.requestServedFromCache({ requestId: 'cache' });
accumulator.responseReceived({ requestId: 'cache', response: { fromDiskCache: true } });
accumulator.loadingFinished({ requestId: 'cache', encodedDataLength: 9000 });

accumulator.requestWillBeSent({ requestId: 'local', type: 'XHR', request: { method: 'POST', url: 'https://www.target.com/locally-fulfilled' } });
accumulator.responseReceived({ requestId: 'local', response: {} });
accumulator.loadingFinished({ requestId: 'local', encodedDataLength: 8000 });

const blockedRequest = {
  url: () => 'https://www.target.com/hero.jpg',
  method: () => 'GET',
  resourceType: () => 'image',
};
accumulator.requestWillBeSent({ requestId: 'blocked', type: 'Image', request: { method: 'GET', url: blockedRequest.url() } });
accumulator.noteBlocked(blockedRequest);
accumulator.loadingFailed({ requestId: 'blocked' });

accumulator.requestWillBeSent({ requestId: 'failed', type: 'Fetch', request: failed });
accumulator.loadingFailed({ requestId: 'failed' });

const sample = accumulator.snapshot();
assert.equal(sample.downloadBytes, 2048, 'only network response bytes should count');
assert.equal(sample.uploadBytes, estimateRequestBytes(normal) + estimateRequestBytes(failed));
assert.equal(sample.totalBytes, sample.downloadBytes + sample.uploadBytes);
assert.equal(sample.requests, 2, 'cache, blocked, and local fulfill requests should not count as wire requests');
assert.equal(sample.blockedRequests, 1);
assert.equal(sample.cachedRequests, 1);
assert.equal(sample.failedRequests, 1);

const redirects = createBandwidthAccumulator();
redirects.requestWillBeSent({ requestId: 'redirect', type: 'Document', request: { method: 'GET', url: 'https://target.com/start' } });
redirects.requestWillBeSent({
  requestId: 'redirect', type: 'Document',
  redirectResponse: { encodedDataLength: 350 },
  request: { method: 'GET', url: 'https://www.target.com/end' },
});
redirects.responseReceived({ requestId: 'redirect', response: {} });
redirects.loadingFinished({ requestId: 'redirect', encodedDataLength: 650 });
assert.equal(redirects.snapshot().requests, 2, 'redirect hops must each count as proxy requests');
assert.equal(redirects.snapshot().downloadBytes, 1000, 'redirect response bytes must not be lost');

class FakeCdpSession extends EventEmitter {
  commands = [];
  detached = false;
  async send(command) { this.commands.push(command); }
  async detach() { this.detached = true; }
}
const fakeSession = new FakeCdpSession();
const pageMeter = await createPageBandwidthMeter({ newCDPSession: async () => fakeSession }, {});
fakeSession.emit('Network.requestWillBeSent', {
  requestId: 'meter', type: 'Script', request: { method: 'GET', url: 'https://target.com/app.js' },
});
fakeSession.emit('Network.responseReceived', { requestId: 'meter', response: {} });
fakeSession.emit('Network.loadingFinished', { requestId: 'meter', encodedDataLength: 1234 });
const metered = await pageMeter.stop();
assert.equal(metered.supported, true);
assert.equal(metered.downloadBytes, 1234);
assert.deepEqual(fakeSession.commands, ['Network.enable', 'Network.disable']);
assert.equal(fakeSession.detached, true);

let installedHandler = null;
let blockedCallbackCount = 0;
const page = {
  async route(_pattern, handler) { installedHandler = handler; },
  async unroute() {},
};
await installHeavyResourceBlock(page, { enabled: true, onBlocked: () => { blockedCallbackCount += 1; } });
let aborted = false;
await installedHandler({ request: () => blockedRequest, abort: () => { aborted = true; }, continue: () => {} });
assert.equal(aborted, true);
assert.equal(blockedCallbackCount, 1);

const now = 1_800_000_000_000;
const proxyRuntime = {
  startedAt: now - 3_600_000,
  bandwidth: {
    available: true, supported: true, attempts: 4, cookies: 2,
    downloadBytes: 4_000_000, uploadBytes: 200_000, totalBytes: 4_200_000,
    proxyBytes: 4_200_000, directBytes: 0,
    proxyDownloadBytes: 4_000_000, proxyUploadBytes: 200_000, proxyCookies: 2,
    requests: 80, blockedRequests: 20, cachedRequests: 3, failedRequests: 2,
    proxyRequests: 80, proxyBlockedRequests: 20, proxyCachedRequests: 3, proxyFailedRequests: 2,
  },
};
const directRuntime = {
  startedAt: now - 3_600_000,
  bandwidth: {
    available: true, supported: true, attempts: 1, cookies: 1,
    downloadBytes: 900_000, uploadBytes: 100_000, totalBytes: 1_000_000,
    proxyBytes: 0, directBytes: 1_000_000,
    directDownloadBytes: 900_000, directUploadBytes: 100_000, directCookies: 1,
    requests: 12, blockedRequests: 4, cachedRequests: 1, failedRequests: 0,
    directRequests: 12, directBlockedRequests: 4, directCachedRequests: 1, directFailedRequests: 0,
  },
};
const proxyMetrics = targetHarvesterBandwidth(proxyRuntime, now);
assert.equal(proxyMetrics.bytesPerHour, 4_200_000);
assert.equal(proxyMetrics.bytesPerCookie, 2_100_000);
const summary = targetBandwidthSummary([proxyRuntime, directRuntime], now);
assert.equal(summary.proxyBytes, 4_200_000);
assert.equal(summary.directBytes, 1_000_000);
assert.equal(summary.bytesPerProxyCookie, 2_100_000);
assert.equal(summary.requests, 80, 'aggregate proxy telemetry must exclude direct requests');
assert.equal(formatBandwidth(4_200_000), '4.20 MB');

console.log('Shape browser wire-bandwidth accounting and renderer metrics passed');
