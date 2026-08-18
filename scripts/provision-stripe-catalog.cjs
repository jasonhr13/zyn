#!/usr/bin/env node
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const catalogPath = path.join(projectRoot, 'config', 'billing-catalog.json');
const workerCatalogPath = path.join(projectRoot, 'cloudflare', 'license', 'src', 'billing-catalog.js');
const keychainService = 'com.thwebco.hope.license-api';

function usage() {
  console.error('Usage: node scripts/provision-stripe-catalog.cjs [--sandbox|--live] [--force]');
  process.exit(2);
}

function keychainValue(account) {
  try {
    return execFileSync('security', [
      'find-generic-password', '-a', account, '-s', keychainService, '-w',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function flatten(value, body = new URLSearchParams(), prefix = '') {
  if (value == null) return body;
  if (Array.isArray(value)) {
    value.forEach((item, index) => flatten(item, body, prefix ? `${prefix}[${index}]` : String(index)));
    return body;
  }
  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      flatten(item, body, prefix ? `${prefix}[${key}]` : key);
    }
    return body;
  }
  body.append(prefix, String(value));
  return body;
}

async function stripe(secret, method, pathname, params) {
  const response = await fetch(`https://api.stripe.com/v1${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${secret}`,
      'content-type': 'application/x-www-form-urlencoded',
      'stripe-version': '2024-06-20',
    },
    body: method === 'GET' ? undefined : flatten(params || {}),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error((payload && payload.error && payload.error.message) || `Stripe ${method} ${pathname} failed`);
  }
  return payload;
}

function snapshotJs(catalog) {
  return `// Frozen snapshot of config/billing-catalog.json. Workers cannot read the repo
// file at runtime. scripts/billing-catalog-smoke-test.js fails if they drift.
export const BILLING_CATALOG = Object.freeze(${JSON.stringify(catalog, null, 2)
    .replaceAll('\n', '\n  ')
    .replace('  {', '{')});
`;
}

function writeWorkerSnapshot(catalog) {
  const current = fs.readFileSync(workerCatalogPath, 'utf8');
  const start = current.indexOf('export const BILLING_CATALOG');
  const helpersStart = current.indexOf('\nexport function defaultPlan');
  if (start < 0 || helpersStart < 0) {
    throw new Error('cloudflare/license/src/billing-catalog.js is missing the expected catalog snapshot');
  }
  const prefix = current.slice(0, start);
  const suffix = current.slice(helpersStart);
  const rendered = `${JSON.stringify(catalog, null, 2)}`
    .split('\n')
    .map((line, index) => (index === 0 ? line : `  ${line}`))
    .join('\n');
  fs.writeFileSync(
    workerCatalogPath,
    `${prefix}export const BILLING_CATALOG = Object.freeze(${rendered});${suffix}`,
  );
}

async function ensurePrice(secret, productId, spec, existingId, force) {
  if (existingId && !force) {
    try {
      const current = await stripe(secret, 'GET', `/prices/${existingId}`);
      if (current && current.id) return current.id;
    } catch {
      // Recreate when the stored id is gone in this Stripe account.
    }
  }
  const payload = {
    product: productId,
    unit_amount: spec.amountCents,
    currency: spec.currency,
    nickname: spec.label,
    metadata: { kind: spec.kind },
  };
  if (spec.kind === 'recurring') {
    payload.recurring = {
      interval: spec.interval,
      interval_count: spec.intervalCount,
    };
  }
  const created = await stripe(secret, 'POST', '/prices', payload);
  return created.id;
}

(async () => {
  const args = new Set(process.argv.slice(2));
  if (args.has('-h') || args.has('--help')) usage();
  const force = args.has('--force');
  const wantLive = args.has('--live');
  const wantSandbox = args.has('--sandbox') || !wantLive;
  if (wantLive && args.has('--sandbox')) usage();

  const secretAccount = wantLive ? 'stripe-secret-key-live' : 'stripe-secret-key-sandbox';
  const secret = process.env.STRIPE_SECRET_KEY || keychainValue(secretAccount);
  if (!secret) {
    console.error(`Missing Stripe secret. Set STRIPE_SECRET_KEY or Keychain ${keychainService}/${secretAccount}.`);
    process.exit(1);
  }
  const mode = secret.startsWith('sk_live_') ? 'live' : (secret.startsWith('sk_test_') ? 'sandbox' : '');
  if (!mode) {
    console.error('STRIPE_SECRET_KEY must start with sk_test_ or sk_live_.');
    process.exit(1);
  }
  if (wantLive && mode !== 'live') {
    console.error('Refusing to provision live: the supplied key is not a live secret.');
    process.exit(1);
  }
  if (wantSandbox && mode !== 'sandbox') {
    console.error('Refusing to provision sandbox: the supplied key is not a test secret.');
    process.exit(1);
  }

  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  if (!catalog.stripe) catalog.stripe = {};
  if (!catalog.stripe[mode]) catalog.stripe[mode] = {};

  for (const plan of catalog.plans || []) {
    const existing = catalog.stripe[mode][plan.id] || {};
    let productId = existing.productId || '';
    if (productId && !force) {
      try {
        const product = await stripe(secret, 'GET', `/products/${productId}`);
        productId = product.id;
      } catch {
        productId = '';
      }
    }
    if (!productId) {
      const product = await stripe(secret, 'POST', '/products', {
        name: plan.name,
        description: plan.description,
        metadata: { plan_id: plan.id },
      });
      productId = product.id;
    }
    const introPriceId = await ensurePrice(secret, productId, plan.intro, existing.introPriceId, force);
    const renewalPriceId = await ensurePrice(secret, productId, plan.renewal, existing.renewalPriceId, force);
    catalog.stripe[mode][plan.id] = { productId, introPriceId, renewalPriceId };
    console.log(`${mode} ${plan.id}: product=${productId} intro=${introPriceId} renewal=${renewalPriceId}`);
  }

  fs.writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  writeWorkerSnapshot(catalog);
  console.log(`Updated ${path.relative(projectRoot, catalogPath)} and the Worker catalog snapshot.`);
})().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
