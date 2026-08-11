#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const LEGACY_NAME = Buffer.from('Polar AIO');
const LEGACY_AVATAR = Buffer.from('https://media.discordapp.net/attachments/1443088896396361731/1487029472778518558/Adobe_Express_-_file.png');
const ZYN_AVATAR = Buffer.from('https://zynbot.app/zyn-icon.png');

function verifyNativeWebhookBrand(file) {
  const body = fs.readFileSync(file);
  assert.equal(body.includes(LEGACY_NAME), false, `${path.basename(file)} contains the Polar AIO webhook identity`);
  assert.equal(body.includes(LEGACY_AVATAR), false, `${path.basename(file)} contains the legacy webhook avatar`);
  assert.equal(body.includes(ZYN_AVATAR), true, `${path.basename(file)} does not contain the Zyn webhook avatar`);
}

if (require.main === module) {
  const files = process.argv.slice(2).map(file => path.resolve(file));
  if (!files.length) {
    console.error('Usage: verify-zyn-native-webhook-brand.cjs <native-engine> [...]');
    process.exit(2);
  }
  for (const file of files) {
    verifyNativeWebhookBrand(file);
    console.log(`Verified Zyn native webhook branding in ${file}`);
  }
}

module.exports = { verifyNativeWebhookBrand };
