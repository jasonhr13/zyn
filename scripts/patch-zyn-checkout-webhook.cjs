#!/usr/bin/env node
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const keychainAccount = process.env.ZYN_CHECKOUT_WEBHOOK_KEYCHAIN_ACCOUNT || 'zyn-reporter';
const keychainService = process.env.ZYN_CHECKOUT_WEBHOOK_KEYCHAIN_SERVICE || 'com.thwebco.zyn.checkout-webhook';
const zynAvatar = 'https://zynbot.app/zyn-icon.png';

function validWebhook(value) {
  try {
    const url = new URL(String(value || '').trim());
    const parts = url.pathname.split('/').filter(Boolean);
    return url.protocol === 'https:'
      && (url.hostname === 'discord.com' || url.hostname === 'discordapp.com')
      && parts.length === 4
      && parts[0] === 'api'
      && parts[1] === 'webhooks'
      && /^\d+$/.test(parts[2])
      && /^[A-Za-z0-9_-]+$/.test(parts[3]);
  } catch {
    return false;
  }
}

function checkoutWebhook() {
  const configured = String(process.env.ZYN_GLOBAL_CHECKOUT_WEBHOOK || '').trim();
  if (configured) return configured;
  try {
    return execFileSync('security', [
      'find-generic-password', '-a', keychainAccount, '-s', keychainService, '-w',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    throw new Error('Global checkout webhook is missing from Keychain. Run scripts/configure-zyn-checkout-webhook.cjs before building.');
  }
}

function replaceReporter(source, webhook) {
  const assignment = /const GLOBAL_WEBHOOK\s*=\s*(?:['"]https:\/\/(?:discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+['"]|['"]__ZYN_GLOBAL_CHECKOUT_WEBHOOK__['"]);/g;
  const matches = source.match(assignment) || [];
  if (matches.length !== 1) throw new Error(`Expected one checkout-reporter webhook assignment, found ${matches.length}`);
  source = source.replace(assignment, `const GLOBAL_WEBHOOK =\n  ${JSON.stringify(webhook)};`);
  source = source.replace(
    `//   2. the global Discord webhook           → your collector channel, tagged with Buyer`,
    `//   2. confirmed successes to the global Discord webhook → your collector channel, tagged with Buyer`,
  );
  const collectorAnchor = `  // ── 2. global collector webhook ─────────────────────────────────────────`;
  if ((source.split(collectorAnchor).length - 1) !== 1) {
    throw new Error('Expected one central collector section');
  }
  source = source.replace(collectorAnchor, `  // Declines remain useful in the user's private analytics, but they are commonly a cart that lost
  // stock rather than a genuine checkout failure. Never send those noisy events to the operator's
  // global Discord collector.
  if (!ok) return;

${collectorAnchor}`);
  const payloadAnchor = `  await postJson(GLOBAL_WEBHOOK, {
    embeds: [`;
  if ((source.split(payloadAnchor).length - 1) !== 1) throw new Error('Expected one central collector payload');
  source = source.replace(payloadAnchor, `  await postJson(GLOBAL_WEBHOOK, {
    username: 'Zyn',
    avatar_url: '${zynAvatar}',
    embeds: [`);
  const timestampAnchor = `        fields,
        timestamp: new Date().toISOString(),`;
  if ((source.split(timestampAnchor).length - 1) !== 1) throw new Error('Expected one central collector embed');
  return source.replace(timestampAnchor, `        fields,
        footer: { text: 'Zyn', icon_url: '${zynAvatar}' },
        timestamp: new Date().toISOString(),`);
}

function replacePbandai(source, webhook) {
  const literal = /(?:https:\/\/(?:discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+|__ZYN_GLOBAL_CHECKOUT_WEBHOOK__)/g;
  const matches = source.match(literal) || [];
  if (matches.length !== 1) throw new Error(`Expected one P-Bandai collector webhook, found ${matches.length}`);
  source = source.replace(literal, webhook);
  const outcomeAnchor = 'await ye([t.webhook,we],be(t,e,a,s[n]||n),$e(e))';
  if ((source.split(outcomeAnchor).length - 1) !== 1) {
    throw new Error('Expected one P-Bandai final-outcome collector call');
  }
  // Keep the user's own P-Bandai webhook behavior intact, but add the operator collector only for
  // a confirmed order. This mirrors the central native reporter policy.
  return source.replace(
    outcomeAnchor,
    'await ye([t.webhook,...(n==="confirmed"?[we]:[])],be(t,e,a,s[n]||n),$e(e))',
  );
}

const files = process.argv.slice(2).map(file => path.resolve(file));
if (!files.length) {
  console.error('Usage: patch-zyn-checkout-webhook.cjs <checkout-reporter.js|pbandai-buyer.cjs> [...]');
  process.exit(2);
}
const webhook = checkoutWebhook();
if (!validWebhook(webhook)) throw new Error('Global checkout webhook is not a valid Discord webhook URL.');

for (const file of files) {
  const name = path.basename(file);
  const before = fs.readFileSync(file, 'utf8');
  const after = name === 'checkout-reporter.js'
    ? replaceReporter(before, webhook)
    : name === 'pbandai-buyer.cjs'
      ? replacePbandai(before, webhook)
      : (() => { throw new Error(`Unsupported checkout reporter file: ${name}`); })();
  if (after === before) throw new Error(`Checkout webhook patch made no change to ${file}`);
  fs.writeFileSync(file, after, 'utf8');
  console.log(`Configured global checkout reporting in ${name}`);
}
