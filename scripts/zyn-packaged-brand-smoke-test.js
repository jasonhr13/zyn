#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const asar = require('../frontend/node_modules/@electron/asar');
const { verifyNativeWebhookBrand } = require('./verify-zyn-native-webhook-brand.cjs');

const appPaths = process.argv.slice(2);
if (!appPaths.length) {
  console.error('Usage: node scripts/zyn-packaged-brand-smoke-test.js <Zyn.app> [Zyn.app ...]');
  process.exit(1);
}

for (const input of appPaths) {
  const app = path.resolve(input);
  const resources = path.join(app, 'Contents', 'Resources');
  const archive = path.join(resources, 'app-original.asar');
  assert.ok(fs.existsSync(archive), `Missing renderer archive: ${archive}`);

  const rendererText = asar.listPackage(archive)
    .filter(file => /^\/build\//.test(file) && /\.(?:css|html|js|json|txt)$/i.test(file))
    .map(file => asar.extractFile(archive, file.replace(/^\//, '')).toString('utf8'))
    .join('\n');
  const launcherText = fs.readdirSync(path.join(resources, 'app'))
    .filter(file => file.endsWith('.js'))
    .map(file => fs.readFileSync(path.join(resources, 'app', file), 'utf8'))
    .join('\n');
  const productCopy = `${rendererText}\n${launcherText}`;

  assert.match(rendererText, /Zyn/, `${app} renderer does not contain Zyn branding`);
  assert.doesNotMatch(productCopy, /rCart/, `${app} still contains retired rCart product copy`);
  assert.doesNotMatch(productCopy, /\bHope\b/i, `${app} still contains previous product copy`);
  assert.doesNotMatch(rendererText, /\bPolar\b/i, `${app} renderer still contains previous product copy`);
  assert.doesNotMatch(productCopy, /control[ -]plane/i, `${app} still contains retired terminology`);
  verifyNativeWebhookBrand(path.join(resources, 'engine', 'backend'));
  for (const name of ['pbandai-buyer.cjs', 'shared.mjs']) {
    const source = fs.readFileSync(path.join(resources, 'bot', name), 'utf8');
    assert.match(source, /username\s*:\s*["']Zyn["']/, `${app} ${name} omits the Zyn webhook identity`);
    assert.doesNotMatch(source, /username\s*:\s*["'](?:Hope|Polar AIO)["']/,
      `${app} ${name} retains a legacy webhook identity`);
  }

  console.log(JSON.stringify({ ok: true, app, rendererFiles: asar.listPackage(archive).filter(file => /^\/build\//.test(file)).length }));
}
