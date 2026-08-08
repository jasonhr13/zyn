#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const { verifyManifest, MANIFEST_PATH } = require('../launcher/runtime-manager');

const origin = (process.env.ZYN_UPDATE_ORIGIN || 'https://updates.rcart.app').replace(/\/+$/, '');

async function checkedFetch(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${url} failed: ${response.status}`);
  return response;
}

async function main() {
  const manifestResponse = await checkedFetch(`${origin}${MANIFEST_PATH}?verify=${Date.now()}`, {
    headers: { 'cache-control': 'no-cache' },
  });
  const payload = verifyManifest(await manifestResponse.json());
  const items = [...new Map([
    ...Object.values(payload.platforms || {}).flatMap(platform => Object.values(platform)),
    payload.engine,
  ].filter(Boolean).map(item => [item.archive, item])).values()];

  for (const item of items) {
    const url = new URL(item.url, origin).toString();
    const head = await checkedFetch(url, { method: 'HEAD' });
    assert.equal(Number(head.headers.get('content-length')), item.size, `${item.archive}: size mismatch`);
    assert.equal(head.headers.get('accept-ranges'), 'bytes', `${item.archive}: range support missing`);
    const range = await checkedFetch(url, { headers: { range: 'bytes=0-31' } });
    assert.equal(range.status, 206, `${item.archive}: range response is not partial`);
    assert.equal((await range.arrayBuffer()).byteLength, 32, `${item.archive}: range length mismatch`);
    console.log(`${item.archive}: ${(item.size / 1048576).toFixed(1)} MiB`);
  }
  console.log(`Verified signed Zyn runtime channel: ${origin}${MANIFEST_PATH}`);
}

main().catch(error => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
