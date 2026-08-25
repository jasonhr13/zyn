#!/usr/bin/env node
'use strict';

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const { wranglerNode } = require('./wrangler-node.cjs');

const projectRoot = path.join(__dirname, '..');
const config = path.join(projectRoot, 'cloudflare', 'updates', 'wrangler.jsonc');
const wrangler = path.join(projectRoot, 'site', 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const keychainAccount = 'zyn-updates';
const tokenService = 'com.thwebco.zyn.discord-relay-token';
const webhookService = 'com.thwebco.zyn.discord-relay-webhook';

function validWebhook(value) {
  try {
    const url = new URL(String(value || '').trim());
    const parts = url.pathname.split('/').filter(Boolean);
    return url.protocol === 'https:'
      && (url.hostname === 'discord.com' || url.hostname === 'discordapp.com')
      && parts[0] === 'api'
      && parts[1] === 'webhooks'
      && /^\d+$/.test(parts[2])
      && /^[A-Za-z0-9_-]+$/.test(parts[3]);
  } catch {
    return false;
  }
}

function keychain(service) {
  try {
    return execFileSync('security', [
      'find-generic-password', '-a', keychainAccount, '-s', service, '-w',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function saveKeychain(service, value) {
  execFileSync('security', [
    'add-generic-password', '-U',
    '-a', keychainAccount,
    '-s', service,
    '-w', value,
  ], { stdio: ['ignore', 'ignore', 'inherit'] });
}

function putSecret(name, value) {
  execFileSync(wranglerNode(), [wrangler, 'secret', 'put', name, '--config', config], {
    cwd: projectRoot,
    input: `${value}\n`,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
}

let token = String(process.env.ZYN_DISCORD_RELAY_TOKEN || keychain(tokenService) || '').trim();
if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) {
  token = crypto.randomBytes(24).toString('base64url');
}
const webhook = String(process.env.ZYN_DISCORD_RELAY_WEBHOOK || keychain(webhookService) || '').trim();
if (!validWebhook(webhook)) {
  throw new Error(
    'Set ZYN_DISCORD_RELAY_WEBHOOK to your Discord webhook URL, or store it in Keychain as '
    + `${webhookService} (account ${keychainAccount}).`,
  );
}

putSecret('ZYN_DISCORD_RELAY_TOKEN', token);
putSecret('ZYN_DISCORD_RELAY_WEBHOOK', webhook);
saveKeychain(tokenService, token);
saveKeychain(webhookService, webhook);

console.log('Zyn Discord relay is configured.');
console.log(`Inbound URL: https://updates.zynbot.app/api/webhooks/1/${token}`);
console.log('Paste that URL in the app as the Discord webhook. The worker rebrands the payload as Zyn, then posts to your Discord channel.');
