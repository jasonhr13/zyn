import assert from 'node:assert/strict';
import test from 'node:test';
import {
  accessUntilFromIntro,
  billingPublicFields,
  checkoutSessionParams,
  flattenStripeParams,
  paidAccessFailure,
  publicCatalog,
  stripeModeFromSecret,
  verifyStripeSignature,
} from '../src/billing.js';
import { BILLING_CATALOG, defaultPlan, planStripeIds } from '../src/billing-catalog.js';
import worker, { __test } from '../src/index.js';

test('catalog prices match the $100 / two-month then $40 monthly plan', () => {
  const plan = defaultPlan();
  assert.equal(plan.id, 'zyn-standard');
  assert.equal(plan.intro.amountCents, 10000);
  assert.equal(plan.intro.accessDays, 60);
  assert.equal(plan.renewal.amountCents, 4000);
  assert.equal(plan.renewal.trialDays, 60);
  assert.deepEqual(plan.taskTypes, ['pokemoncenter']);
  const published = publicCatalog();
  assert.equal(published.plan.intro.amountCents, 10000);
  assert.equal(stripeModeFromSecret('sk_test_abc'), 'sandbox');
  assert.equal(stripeModeFromSecret('sk_live_abc'), 'live');
  assert.equal(planStripeIds('zyn-standard', 'sk_test_abc'), null);
});

test('login and validation expose public billing fields', () => {
  assert.deepEqual(billingPublicFields({
    billing_plan: 'zyn-standard', billing_status: 'active', access_until: 1700,
  }), {
    billingPlan: 'zyn-standard', billingStatus: 'active', accessUntil: 1700,
  });
  assert.deepEqual(billingPublicFields({}), {
    billingPlan: '', billingStatus: '', accessUntil: 0,
  });
});

test('paid access is unrestricted until a paid expiry is stored', () => {
  assert.equal(paidAccessFailure({ access_until: null }, 1000), null);
  assert.equal(paidAccessFailure({ access_until: 2000 }, 1000), null);
  assert.equal(paidAccessFailure({ access_until: 999 }, 1000).code, 'subscription_expired');
  assert.equal(__test.paidAccessFailure({ access_until: 1 }, 2).code, 'subscription_expired');
});

test('checkout session charges the intro price now and trials the monthly renewal', () => {
  const plan = defaultPlan(BILLING_CATALOG);
  const params = checkoutSessionParams({
    plan,
    prices: { introPriceId: 'price_intro', renewalPriceId: 'price_month' },
    email: 'buyer@example.com',
    successUrl: 'https://zynbot.app/buy/success?session_id={CHECKOUT_SESSION_ID}',
    cancelUrl: 'https://zynbot.app/buy',
  });
  assert.equal(params.mode, 'subscription');
  assert.deepEqual(params.line_items, [
    { price: 'price_intro', quantity: 1 },
    { price: 'price_month', quantity: 1 },
  ]);
  assert.equal(params.subscription_data.trial_period_days, 60);
  const encoded = flattenStripeParams(params);
  assert.equal(encoded.get('line_items[0][price]'), 'price_intro');
  assert.equal(encoded.get('subscription_data[trial_period_days]'), '60');
  assert.equal(accessUntilFromIntro(plan, 0), 60 * 24 * 60 * 60 * 1000);
});

test('rejects Stripe webhooks with a stale or unsigned header', async () => {
  assert.equal(await verifyStripeSignature('{}', '', 'whsec_test', 1_700_000_000_000), false);
  assert.equal(await verifyStripeSignature('{}', 't=1,v1=abcd', 'whsec_test', 1_700_000_000_000), false);
});

test('publishes the billing catalog without Stripe secrets', async () => {
  const response = await worker.fetch(new Request('https://license.zynbot.app/api/billing/catalog'), {});
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.plan.id, 'zyn-standard');
  assert.equal(body.plan.intro.amountCents, 10000);
  assert.equal(body.plan.renewal.amountCents, 4000);
});
