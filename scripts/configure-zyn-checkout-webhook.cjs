#!/usr/bin/env node
'use strict';

const { execFileSync } = require('child_process');
const readline = require('readline');

const account = 'zyn-reporter';
const publicService = 'com.thwebco.zyn.checkout-webhook';
const privateService = 'com.thwebco.zyn.checkout-webhook-private';

async function readWebhook() {
  const configured = String(
    process.env.ZYN_PUBLIC_CHECKOUT_WEBHOOK || process.env.ZYN_GLOBAL_CHECKOUT_WEBHOOK || '',
  ).trim();
  if (configured) return configured;

  process.stderr.write('Paste the public Discord checkout webhook, then press Return:\n');
  const restoreRawMode = Boolean(process.stdin.isTTY && process.stdin.setRawMode);
  if (restoreRawMode) process.stdin.setRawMode(true);
  const input = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
    terminal: false,
  });
  const [line = ''] = await new Promise((resolve) => {
    const lines = [];
    input.on('line', (value) => {
      lines.push(value);
      input.close();
    });
    input.on('close', () => resolve(lines));
  });
  if (restoreRawMode) process.stdin.setRawMode(false);
  return line.trim();
}

function assertWebhook(webhook, label) {
  let url;
  try { url = new URL(webhook); } catch { throw new Error(`The supplied ${label} checkout webhook is not a URL.`); }
  const parts = url.pathname.split('/').filter(Boolean);
  if (url.protocol !== 'https:'
    || (url.hostname !== 'discord.com' && url.hostname !== 'discordapp.com')
    || parts.length !== 4
    || parts[0] !== 'api'
    || parts[1] !== 'webhooks'
    || !/^\d+$/.test(parts[2])
    || !/^[A-Za-z0-9_-]+$/.test(parts[3])) {
    throw new Error(`The supplied ${label} checkout webhook is not a valid Discord webhook URL.`);
  }
  return webhook;
}

function saveWebhook(service, webhook) {
  execFileSync('security', [
    'add-generic-password', '-U', '-a', account, '-s', service, '-w', webhook,
  ], { stdio: ['ignore', 'ignore', 'inherit'] });
}

async function main() {
  const publicWebhook = assertWebhook(await readWebhook(), 'public');
  saveWebhook(publicService, publicWebhook);
  console.log('Public checkout webhook saved to Keychain for release builds.');

  const privateWebhook = String(process.env.ZYN_PRIVATE_CHECKOUT_WEBHOOK || '').trim();
  if (!privateWebhook) {
    console.log('Private checkout webhook unchanged. Set ZYN_PRIVATE_CHECKOUT_WEBHOOK to update it.');
    return;
  }
  saveWebhook(privateService, assertWebhook(privateWebhook, 'private'));
  console.log('Private checkout webhook saved to Keychain for release builds.');
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
