#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RuntimeManager } = require('../launcher/runtime-manager');

const requested = String(process.argv[2] || process.arch).toLowerCase();
const arch = requested === 'x86_64' ? 'x64' : requested;
if (!['arm64', 'x64'].includes(arch)) {
  console.error('Usage: node scripts/zyn-production-runtime-install-smoke.cjs [arm64|x64]');
  process.exit(2);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), `zyn-production-runtime-${arch}-`));
let lastProgress = '';

async function main() {
  const manager = new RuntimeManager({
    enabled: true,
    platform: 'darwin',
    arch,
    root,
    onStatus(status) {
      const progress = `${status.state}:${Math.floor((status.percent || 0) / 10) * 10}`;
      if (progress !== lastProgress) {
        lastProgress = progress;
        console.log(`${arch}: ${status.message} ${status.percent || 0}%`);
      }
    },
  });
  await manager.initialize();
  const status = await manager.ensureAll();
  assert.equal(status.ready, true);
  assert.equal(status.state, 'ready');
  assert.ok(fs.existsSync(process.env.ZYN_PLAYWRIGHT_BROWSERS_PATH));
  assert.deepEqual(Object.keys(status.items), ['chromium']);
  console.log(JSON.stringify({
    ok: true,
    arch,
    totalMiB: Number((status.totalBytes / 1048576).toFixed(1)),
    components: Object.fromEntries(Object.entries(status.items).map(([name, item]) => [name, item.version])),
  }, null, 2));
}

main().catch(error => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(root, { recursive: true, force: true });
});
