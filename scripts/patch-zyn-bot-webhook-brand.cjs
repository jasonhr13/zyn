#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const botDir = process.argv[2] && path.resolve(process.argv[2]);
if (!botDir || !fs.existsSync(botDir)) {
  console.error('Usage: patch-zyn-bot-webhook-brand.cjs <packaged-bot-directory>');
  process.exit(2);
}

const avatar = 'https://zynbot.app/zyn-icon.png';
const read = name => fs.readFileSync(path.join(botDir, name), 'utf8');

function verifyWebhookBrand(name, { footer = true } = {}) {
  const source = read(name);
  if (!source.includes('Zyn') || !source.includes(avatar)) {
    throw new Error(`${name} does not contain the canonical Zyn webhook identity`);
  }
  if (/username\s*:\s*["'](?:Hope|Polar AIO)["']|ACCOUNT_GLOBAL_WEBHOOK/.test(source)) {
    throw new Error(`${name} contains legacy branding or a global account webhook`);
  }
  if (footer && !/footer\s*:\s*\{\s*text\s*:\s*["']Zyn["']/.test(source)) {
    throw new Error(`${name} does not contain the canonical Zyn webhook footer`);
  }
}

verifyWebhookBrand('pbandai-buyer.cjs');
verifyWebhookBrand('secret-lair-browserless.mjs');
verifyWebhookBrand('shared.mjs');

if (/\bHope\b/i.test(read('round1-register.mjs'))) {
  throw new Error('round1-register.mjs contains a legacy product reference');
}

for (const name of fs.readdirSync(botDir)) {
  if (!/\.(?:c?js|mjs)$/.test(name)) continue;
  const source = read(name);
  if (/https:\/\/(?:discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/.test(source)) {
    throw new Error(`${name} contains an embedded Discord webhook credential`);
  }
}

console.log('Verified tracked Zyn bot webhook branding and credential boundary.');
