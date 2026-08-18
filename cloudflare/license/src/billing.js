import {
  BILLING_CATALOG,
  defaultPlan,
  planById,
  planStripeIds,
  publicCatalog,
  stripeModeFromSecret,
} from './billing-catalog.js';

export const SUBSCRIPTION_EXPIRED = Object.freeze({
  code: 'subscription_expired',
  message: 'Your Zyn subscription has ended. Renew at zynbot.app/buy to keep using the app.',
});

const CLAIM_TTL_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function billingPublicFields(user) {
  return {
    billingPlan: String((user && user.billing_plan) || ''),
    billingStatus: String((user && user.billing_status) || ''),
    accessUntil: Number(user && user.access_until) || 0,
  };
}

export function paidAccessFailure(user, now = Date.now()) {
  if (!user) return SUBSCRIPTION_EXPIRED;
  if (user.access_until == null || user.access_until === '') return null;
  if (Number(user.access_until) > Number(now)) return null;
  return SUBSCRIPTION_EXPIRED;
}

export function flattenStripeParams(value, body = new URLSearchParams(), prefix = '') {
  if (value == null) return body;
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      flattenStripeParams(item, body, prefix ? `${prefix}[${index}]` : String(index));
    });
    return body;
  }
  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      flattenStripeParams(item, body, prefix ? `${prefix}[${key}]` : key);
    }
    return body;
  }
  body.append(prefix, String(value));
  return body;
}

export function checkoutSessionParams({
  plan,
  prices,
  email,
  successUrl,
  cancelUrl,
}) {
  return {
    mode: 'subscription',
    customer_email: email,
    client_reference_id: email,
    success_url: successUrl,
    cancel_url: cancelUrl,
    allow_promotion_codes: 'true',
    billing_address_collection: 'auto',
    line_items: [
      { price: prices.introPriceId, quantity: 1 },
      { price: prices.renewalPriceId, quantity: 1 },
    ],
    subscription_data: {
      trial_period_days: Number(plan.renewal.trialDays) || Number(plan.intro.accessDays) || 60,
      metadata: { plan_id: plan.id },
    },
    metadata: { plan_id: plan.id, email },
  };
}

export async function verifyStripeSignature(rawBody, header, secret, now = Date.now()) {
  const parts = String(header || '').split(',').map(part => part.trim());
  const timestamp = parts.find(part => part.startsWith('t='))?.slice(2) || '';
  const signatures = parts.filter(part => part.startsWith('v1=')).map(part => part.slice(3));
  const age = Math.abs(Number(now) / 1000 - Number(timestamp));
  if (!timestamp || !signatures.length || !Number.isFinite(Number(timestamp)) || age > 300) {
    return false;
  }
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(String(secret || '')),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signed = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${timestamp}.${rawBody}`),
  );
  const expected = [...new Uint8Array(signed)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return signatures.some(signature => timingSafeEqualHex(expected, signature));
}

function timingSafeEqualHex(left, right) {
  const a = String(left || '').toLowerCase();
  const b = String(right || '').toLowerCase();
  if (a.length !== b.length || !/^[0-9a-f]+$/.test(a) || !/^[0-9a-f]+$/.test(b)) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
}

export async function stripeRequest(env, method, path, params, fetchImpl = fetch) {
  const secret = String((env && env.STRIPE_SECRET_KEY) || '');
  if (!secret) {
    const error = new Error('Stripe is not configured.');
    error.code = 'STRIPE_UNCONFIGURED';
    throw error;
  }
  const url = new URL(`https://api.stripe.com/v1${path}`);
  const init = {
    method,
    headers: {
      authorization: `Bearer ${secret}`,
      'stripe-version': '2024-06-20',
    },
  };
  if (method === 'GET') {
    if (params) {
      for (const [key, value] of flattenStripeParams(params)) url.searchParams.append(key, value);
    }
  } else {
    init.headers['content-type'] = 'application/x-www-form-urlencoded';
    init.body = flattenStripeParams(params || {});
  }
  const response = await fetchImpl(url, init);
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error((payload && payload.error && payload.error.message) || 'Stripe request failed.');
    error.code = 'STRIPE_REQUEST_FAILED';
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

export function accessUntilFromIntro(plan, now = Date.now()) {
  const days = Number(plan && plan.intro && plan.intro.accessDays) || 60;
  return Number(now) + (days * DAY_MS);
}

export function accessUntilFromPeriodEnd(periodEnd, plan, now = Date.now()) {
  const seconds = Number(periodEnd);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  const days = Number(plan && plan.renewal && plan.renewal.accessDays) || 31;
  return Number(now) + (days * DAY_MS);
}

export function normalizeBillingStatus(status) {
  const value = String(status || '').trim().toLowerCase();
  if (['trialing', 'active', 'past_due', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired'].includes(value)) {
    return value;
  }
  return 'active';
}

export function applyPaidAccessFields({
  planId,
  customerId,
  subscriptionId,
  status,
  accessUntil,
}) {
  return {
    billing_plan: planId,
    stripe_customer_id: customerId || '',
    stripe_subscription_id: subscriptionId || '',
    billing_status: normalizeBillingStatus(status),
    access_until: Number(accessUntil) || 0,
  };
}

export async function createCheckoutSession(env, {
  email,
  successUrl,
  cancelUrl,
  catalog = BILLING_CATALOG,
  stripe = stripeRequest,
}) {
  const plan = defaultPlan(catalog);
  const prices = plan && planStripeIds(plan.id, env && env.STRIPE_SECRET_KEY, catalog);
  if (!plan || !prices) {
    const error = new Error('Billing is not provisioned for this Stripe environment.');
    error.code = 'BILLING_UNPROVISIONED';
    throw error;
  }
  return stripe(env, 'POST', '/checkout/sessions', checkoutSessionParams({
    plan,
    prices,
    email,
    successUrl,
    cancelUrl,
  }));
}

export function catalogSnapshot(catalog = BILLING_CATALOG) {
  return publicCatalog(catalog);
}

export async function rememberStripeEvent(env, event) {
  const id = String(event && event.id || '');
  const type = String(event && event.type || '');
  if (!id || !type) return false;
  const now = Date.now();
  try {
    await env.DB.prepare(`
      INSERT INTO stripe_events (id, type, received_at, processed_at)
      VALUES (?, ?, ?, NULL)
    `).bind(id, type, now).run();
    return true;
  } catch {
    return false;
  }
}

export async function markStripeEventProcessed(env, eventId) {
  if (!eventId) return;
  await env.DB.prepare('UPDATE stripe_events SET processed_at = ? WHERE id = ?')
    .bind(Date.now(), eventId).run();
}

export async function grantPlanTaskTypes(env, userId, plan, now = Date.now()) {
  const types = Array.isArray(plan && plan.taskTypes) ? plan.taskTypes : [];
  if (!types.length) return;
  const statements = types.map(type => env.DB.prepare(`
    INSERT INTO user_task_type_access (user_id, task_type, enabled, updated_at)
    VALUES (?, ?, 1, ?)
    ON CONFLICT(user_id, task_type) DO UPDATE SET
      enabled = 1, updated_at = excluded.updated_at
  `).bind(userId, type, now));
  await env.DB.batch(statements);
}

export async function upsertPaidUser(env, {
  email,
  customerId,
  subscriptionId,
  status,
  accessUntil,
  plan,
  now = Date.now(),
  createUser,
}) {
  let user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  let createdNewUser = false;
  let temporaryPassword = '';
  if (!user) {
    const created = await createUser(env, email, 'stripe_checkout');
    user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(created.user.id).first();
    createdNewUser = true;
    temporaryPassword = created.temporaryPassword;
  }
  await env.DB.prepare(`
    UPDATE users
    SET stripe_customer_id = ?, stripe_subscription_id = ?, billing_plan = ?,
      billing_status = ?, access_until = ?, updated_at = ?
    WHERE id = ?
  `).bind(
    customerId || user.stripe_customer_id || '',
    subscriptionId || user.stripe_subscription_id || '',
    plan.id,
    normalizeBillingStatus(status),
    Number(accessUntil) || 0,
    now,
    user.id,
  ).run();
  await grantPlanTaskTypes(env, user.id, plan, now);
  return {
    user: { ...user, ...applyPaidAccessFields({
      planId: plan.id, customerId, subscriptionId, status, accessUntil,
    }) },
    createdNewUser,
    temporaryPassword,
  };
}

export async function storeBillingClaim(env, {
  checkoutSessionId,
  userId,
  createdNewUser,
  temporaryPassword,
  downloadUrl,
  now = Date.now(),
}) {
  await env.DB.prepare(`
    INSERT INTO billing_claims
      (checkout_session_id, user_id, created_new_user, temporary_password, download_url, claimed_at, created_at)
    VALUES (?, ?, ?, ?, ?, NULL, ?)
    ON CONFLICT(checkout_session_id) DO UPDATE SET
      user_id = excluded.user_id,
      created_new_user = excluded.created_new_user,
      temporary_password = excluded.temporary_password,
      download_url = excluded.download_url
  `).bind(
    checkoutSessionId,
    userId,
    createdNewUser ? 1 : 0,
    createdNewUser ? (temporaryPassword || '') : '',
    downloadUrl || '',
    now,
  ).run();
}

export async function claimBillingSession(env, checkoutSessionId, now = Date.now()) {
  const sessionId = String(checkoutSessionId || '').trim();
  if (!sessionId.startsWith('cs_')) return null;
  const row = await env.DB.prepare(`
    SELECT c.*, u.email
    FROM billing_claims c JOIN users u ON u.id = c.user_id
    WHERE c.checkout_session_id = ?
  `).bind(sessionId).first();
  if (!row) return null;
  if (Number(row.created_at) + CLAIM_TTL_MS < now) return { expired: true };
  const alreadyClaimed = Boolean(row.claimed_at);
  if (!alreadyClaimed) {
    await env.DB.prepare(`
      UPDATE billing_claims
      SET claimed_at = ?, temporary_password = NULL
      WHERE checkout_session_id = ? AND claimed_at IS NULL
    `).bind(now, sessionId).run();
  }
  return {
    email: row.email,
    createdNewUser: Number(row.created_new_user) === 1,
    temporaryPassword: alreadyClaimed ? '' : String(row.temporary_password || ''),
    downloadUrl: String(row.download_url || ''),
    claimed: alreadyClaimed,
  };
}

export function accessUntilFromStripeObject(object, plan, now = Date.now()) {
  const trialEnd = Number(object && object.trial_end);
  if (Number.isFinite(trialEnd) && trialEnd > 0) return trialEnd * 1000;
  const periodEnd = Number(
    (object && object.current_period_end)
    || (object && object.lines && object.lines.data && object.lines.data[0]
      && object.lines.data[0].period && object.lines.data[0].period.end),
  );
  if (Number.isFinite(periodEnd) && periodEnd > 0) return periodEnd * 1000;
  if (object && object.object === 'invoice' && Number(object.amount_paid) > 0 && !object.subscription) {
    return accessUntilFromIntro(plan, now);
  }
  return accessUntilFromIntro(plan, now);
}

export { BILLING_CATALOG, CLAIM_TTL_MS, defaultPlan, planById, publicCatalog, stripeModeFromSecret };
