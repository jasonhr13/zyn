// Frozen snapshot of config/billing-catalog.json. Workers cannot read the repo
// file at runtime. scripts/billing-catalog-smoke-test.js fails if they drift.
export const BILLING_CATALOG = Object.freeze({
    "version": 1,
    "defaultPlan": "zyn-standard",
    "plans": [
      {
        "id": "zyn-standard",
        "name": "Zyn",
        "description": "Desktop checkout for Target and Pokémon Center US.",
        "taskTypes": [
          "pokemoncenter"
        ],
        "intro": {
          "kind": "one_time",
          "amountCents": 10000,
          "currency": "usd",
          "accessDays": 60,
          "label": "First 2 months"
        },
        "renewal": {
          "kind": "recurring",
          "amountCents": 4000,
          "currency": "usd",
          "interval": "month",
          "intervalCount": 1,
          "accessDays": 31,
          "trialDays": 60,
          "label": "Then every month"
        }
      }
    ],
    "stripe": {
      "sandbox": {
        "zyn-standard": {
          "productId": "",
          "introPriceId": "",
          "renewalPriceId": ""
        }
      },
      "live": {
        "zyn-standard": {
          "productId": "prod_V66XXWSv50FmrJ",
          "introPriceId": "price_1U5uKcAgG2EpmCLAPrmeiHMk",
          "renewalPriceId": "price_1U5uKcAgG2EpmCLAJ4hJ8Rrm"
        }
      }
    }
  });
export function defaultPlan(catalog = BILLING_CATALOG) {
  return planById(String((catalog && catalog.defaultPlan) || ''), catalog);
}

export function planById(id, catalog = BILLING_CATALOG) {
  const key = String(id || '').trim();
  return ((catalog && catalog.plans) || []).find(plan => plan && plan.id === key) || null;
}

export function stripeModeFromSecret(secretKey) {
  const value = String(secretKey || '');
  if (value.startsWith('sk_live_')) return 'live';
  if (value.startsWith('sk_test_')) return 'sandbox';
  return '';
}

export function planStripeIds(planId, secretKey, catalog = BILLING_CATALOG) {
  const mode = stripeModeFromSecret(secretKey);
  if (!mode) return null;
  const row = catalog && catalog.stripe && catalog.stripe[mode] && catalog.stripe[mode][planId];
  if (!row || !String(row.introPriceId || '').trim() || !String(row.renewalPriceId || '').trim()) {
    return null;
  }
  return row;
}

export function publicCatalog(catalog = BILLING_CATALOG) {
  const plan = defaultPlan(catalog);
  if (!plan) return { version: Number(catalog && catalog.version) || 1, plan: null };
  return {
    version: Number(catalog.version) || 1,
    plan: {
      id: plan.id,
      name: plan.name,
      description: plan.description,
      intro: { ...plan.intro },
      renewal: { ...plan.renewal },
    },
  };
}

export function mergeStripeIds(catalog, mode, planId, ids) {
  const next = structuredClone(catalog);
  if (!next.stripe) next.stripe = {};
  if (!next.stripe[mode]) next.stripe[mode] = {};
  next.stripe[mode][planId] = {
    ...(next.stripe[mode][planId] || {}),
    ...ids,
  };
  return next;
}
