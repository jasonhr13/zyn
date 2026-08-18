#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const project = path.resolve(__dirname, '..');
const catalog = JSON.parse(fs.readFileSync(path.join(project, 'config', 'billing-catalog.json'), 'utf8'));
const workerCatalog = fs.readFileSync(
  path.join(project, 'cloudflare', 'license', 'src', 'billing-catalog.js'),
  'utf8',
);
const homepage = fs.readFileSync(path.join(project, 'site', 'app', 'page.tsx'), 'utf8');
const buyPage = fs.readFileSync(path.join(project, 'site', 'app', 'buy', 'page.tsx'), 'utf8');
const provisioner = fs.readFileSync(path.join(project, 'scripts', 'provision-stripe-catalog.cjs'), 'utf8');
const license = fs.readFileSync(path.join(project, 'cloudflare', 'license', 'src', 'index.js'), 'utf8');

assert.equal(catalog.defaultPlan, 'zyn-standard');
const plan = catalog.plans.find(item => item.id === 'zyn-standard');
assert.ok(plan);
assert.equal(plan.intro.amountCents, 10000);
assert.equal(plan.intro.accessDays, 60);
assert.equal(plan.renewal.amountCents, 4000);
assert.equal(plan.renewal.interval, 'month');
assert.equal(plan.renewal.trialDays, 60);
assert.deepEqual(plan.taskTypes, ['pokemoncenter']);
assert.ok(catalog.stripe.sandbox['zyn-standard']);
assert.ok(catalog.stripe.live['zyn-standard']);

assert.match(workerCatalog, /amountCents: 10000/);
assert.match(workerCatalog, /amountCents: 4000/);
assert.match(workerCatalog, /taskTypes: Object\.freeze\(\['pokemoncenter'\]\)/);

assert.match(homepage, /\$100 for two months/);
assert.match(homepage, /\$40 every month/);
assert.match(homepage, /Pokémon Center US/);
assert.match(buyPage, /\$100 covers the first two months/);
assert.match(buyPage, /\$40 every month/);
assert.match(buyPage, /action="\/api\/checkout"/);
assert.match(provisioner, /sk_test_/);
assert.match(provisioner, /sk_live_/);
assert.match(license, /\/api\/billing\/checkout/);
assert.match(license, /\/api\/billing\/webhook/);

console.log('Billing catalog, Worker snapshot, and purchase-copy smoke test passed');
