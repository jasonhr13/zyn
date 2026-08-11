#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { verifyZynPackagedBrand } = require('./verify-zyn-packaged-brand-boundary.cjs');

const appPaths = process.argv.slice(2);
if (!appPaths.length) {
  console.error('Usage: node scripts/zyn-packaged-brand-smoke-test.js <Zyn.app> [Zyn.app ...]');
  process.exit(2);
}

for (const input of appPaths) {
  const app = path.resolve(input);
  assert.equal(fs.existsSync(app), true, `Missing packaged app: ${app}`);
  const resources = path.join(app, 'Contents', 'Resources');
  const result = verifyZynPackagedBrand({
    resources,
    engineFile: path.join(resources, 'engine', 'backend'),
    label: app,
  });

  console.log(JSON.stringify({ ok: true, app, ...result }));
}
