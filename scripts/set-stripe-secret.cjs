#!/usr/bin/env node
'use strict';

const { execFileSync } = require('child_process');
const path = require('path');
const { wranglerNode } = require('./wrangler-node.cjs');

const projectRoot = path.join(__dirname, '..');
const config = path.join(projectRoot, 'cloudflare', 'license', 'wrangler.jsonc');
const wrangler = path.join(projectRoot, 'site', 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const keychainService = 'com.thwebco.hope.license-api';
const secret = String(process.env.STRIPE_SECRET_KEY || '').trim();
const webhookSecret = String(process.env.STRIPE_WEBHOOK_SECRET || '').trim();

if (!secret && !webhookSecret) {
  console.error('Set STRIPE_SECRET_KEY and/or STRIPE_WEBHOOK_SECRET in the environment.');
  process.exit(2);
}
if (secret && !/^sk_(test|live)_/.test(secret)) {
  console.error('STRIPE_SECRET_KEY must start with sk_test_ or sk_live_.');
  process.exit(2);
}

function putKeychain(account, value) {
  execFileSync('security', [
    'add-generic-password', '-U', '-a', account, '-s', keychainService, '-w', value,
  ], { stdio: ['ignore', 'ignore', 'inherit'] });
}

function putWorkerSecret(name, value) {
  execFileSync(wranglerNode(), [wrangler, 'secret', 'put', name, '--config', config], {
    cwd: projectRoot,
    input: `${value}\n`,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
}

if (secret) {
  putKeychain(secret.startsWith('sk_live_') ? 'stripe-secret-key-live' : 'stripe-secret-key-sandbox', secret);
  putWorkerSecret('STRIPE_SECRET_KEY', secret);
  console.log(`Stored ${secret.startsWith('sk_live_') ? 'live' : 'test'} Stripe secret in Keychain and Cloudflare.`);
}
if (webhookSecret) {
  putKeychain('stripe-webhook-secret', webhookSecret);
  putWorkerSecret('STRIPE_WEBHOOK_SECRET', webhookSecret);
  console.log('Stored Stripe webhook secret in Keychain and Cloudflare.');
}
