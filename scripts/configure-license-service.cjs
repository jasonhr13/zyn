const { execFileSync } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const { wranglerNode } = require('./wrangler-node.cjs');

const projectRoot = path.join(__dirname, '..');
const config = path.join(projectRoot, 'cloudflare', 'license', 'wrangler.jsonc');
const wrangler = path.join(projectRoot, 'site', 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const keychainService = 'com.thwebco.hope.license-api';

function keychainValue(account, bytes) {
  try {
    return execFileSync('security', [
      'find-generic-password', '-a', account, '-s', keychainService, '-w',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    const value = crypto.randomBytes(bytes).toString('base64url');
    execFileSync('security', [
      'add-generic-password', '-U', '-a', account, '-s', keychainService, '-w', value,
    ], { stdio: ['ignore', 'ignore', 'inherit'] });
    return value;
  }
}

function existingKeychainValue(account) {
  try {
    return execFileSync('security', [
      'find-generic-password', '-a', account, '-s', keychainService, '-w',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

const secrets = {
  ADMIN_PASSWORD: keychainValue('admin-password', 18),
  ADMIN_SESSION_SECRET: keychainValue('admin-session-secret', 32),
  PASSWORD_PEPPER: keychainValue('password-pepper', 32),
  PROXY_ENCRYPTION_KEY: keychainValue('proxy-encryption-key', 32),
  SERVICE_CONFIG_ENCRYPTION_KEY: keychainValue('service-config-encryption-key', 32),
};
const webhook = existingKeychainValue('pokemon-queue-discord-webhook');
if (webhook) secrets.ZYN_POKEMON_QUEUE_DISCORD_WEBHOOK = webhook;
const stripeSecret = existingKeychainValue('stripe-secret-key-live')
  || existingKeychainValue('stripe-secret-key-sandbox');
if (stripeSecret) secrets.STRIPE_SECRET_KEY = stripeSecret;
const stripeWebhook = existingKeychainValue('stripe-webhook-secret');
if (stripeWebhook) secrets.STRIPE_WEBHOOK_SECRET = stripeWebhook;

for (const [name, value] of Object.entries(secrets)) {
  execFileSync(wranglerNode(), [wrangler, 'secret', 'put', name, '--config', config], {
    cwd: projectRoot,
    input: `${value}\n`,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
}

console.log('Zyn license-service secrets are synchronized with Cloudflare and this Mac\'s Keychain.');
