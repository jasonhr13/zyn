#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const project = path.resolve(__dirname, '..');
const sourceDir = process.argv[2] && path.resolve(process.argv[2]);
const destinationDir = path.join(project, 'bot-runtime');
const avatar = 'https://zynbot.app/zyn-icon.png';

if (!sourceDir || !fs.statSync(sourceDir, { throwIfNoEntry: false })?.isDirectory()) {
  console.error('Usage: import-zyn-bot-runtime.cjs <extracted-release-resources/bot>');
  process.exit(2);
}

const files = [
  'aycd-mail-client.mjs',
  'icloud-register.mjs',
  'imap-client.mjs',
  'manual-fallback.mjs',
  'pbandai-buyer.cjs',
  'pbandai-buyer.loader.js',
  'pbandai-register.mjs',
  'pokemoncenter-monitor.mjs',
  'riotgames-register.mjs',
  'round1-mock.html',
  'round1-register.mjs',
  'secret-lair-browserless.mjs',
  'sms-client.mjs',
];

function replaceExactly(source, from, to, expected, label) {
  const count = source.split(from).length - 1;
  if (count !== expected) throw new Error(`Expected ${expected} ${label}, found ${count}`);
  return source.split(from).join(to);
}

function transform(name, source) {
  if (name === 'pbandai-buyer.cjs') {
    const webhook = /https:\/\/(?:discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/g;
    const matches = source.match(webhook) || [];
    if (matches.length !== 1) throw new Error(`Expected one P-Bandai collector webhook, found ${matches.length}`);
    source = source.replace(webhook, '__ZYN_GLOBAL_CHECKOUT_WEBHOOK__');
    source = replaceExactly(source, 'a="Hope"', 'a="Zyn"', 1, 'P-Bandai default webhook titles');
    source = replaceExactly(
      source,
      'username:"Hope"',
      `username:"Zyn",avatar_url:"${avatar}"`,
      1,
      'P-Bandai webhook usernames',
    );
    return replaceExactly(
      source,
      'footer:{text:"Hope"}',
      `footer:{text:"Zyn",icon_url:"${avatar}"}`,
      1,
      'P-Bandai webhook footers',
    );
  }

  if (name === 'secret-lair-browserless.mjs') {
    source = source.replace(
      /const WEBHOOK_URL = 'https:\/\/(?:discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+';/,
      "const WEBHOOK_URL = '';",
    );
    source = replaceExactly(
      source,
      'async function sendWebhook({ success, product, qty, total, email }) {\n  try {',
      `async function sendWebhook({ success, product, qty, total, email, webhook }) {\n  const webhookUrl = String(webhook || WEBHOOK_URL).trim();\n  if (!/^https:\\/\\/(?:discord\\.com|discordapp\\.com)\\/api\\/webhooks\\/\\d+\\/[A-Za-z0-9_-]+$/.test(webhookUrl)) return;\n  try {`,
      1,
      'browserless webhook function',
    );
    source = replaceExactly(source, 'await fetch(WEBHOOK_URL, {', 'await fetch(webhookUrl, {', 1, 'browserless webhook fetch');
    source = replaceExactly(
      source,
      'body   : JSON.stringify({\n        embeds: [{',
      `body   : JSON.stringify({\n        username: 'Zyn',\n        avatar_url: '${avatar}',\n        embeds: [{`,
      1,
      'browserless webhook payloads',
    );
    source = replaceExactly(
      source,
      "footer: { text: 'Secret Lair Bot' },",
      `footer: { text: 'Zyn', icon_url: '${avatar}' },`,
      1,
      'browserless webhook footers',
    );
    source = replaceExactly(
      source,
      'email:profile.email });',
      'email:profile.email, webhook:config.webhook });',
      2,
      'browserless user webhook calls',
    );
    return source;
  }

  if (name === 'round1-register.mjs') {
    return replaceExactly(
      source,
      'so Hope can run many of these at once:',
      'so Zyn can run many of these at once:',
      1,
      'Round1 product references',
    );
  }

  return source;
}

for (const name of files) {
  const input = path.join(sourceDir, name);
  if (!fs.statSync(input, { throwIfNoEntry: false })?.isFile()) throw new Error(`Missing upstream bot file: ${input}`);
  const source = transform(name, fs.readFileSync(input, 'utf8'));
  if (/https:\/\/(?:discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/.test(source)) {
    throw new Error(`${name} still contains a Discord webhook credential`);
  }
  fs.writeFileSync(path.join(destinationDir, name), source, 'utf8');
  console.log(`Imported ${name}`);
}

console.log('Imported the sanitized Zyn bot runtime; encrypted proxy pools were intentionally excluded.');
