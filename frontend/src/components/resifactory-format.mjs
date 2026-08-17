export const DEVELOPER_URL = 'https://resifactory.net';
export const MIN_TOPUP_GB = 0.1;
export const MAX_TOPUP_GB = 1000;
export const MAX_GENERATE_QUANTITY = 5000;

export function formatGb(value) {
  if (value == null || value === '') return '—';
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '—';
  if (amount === 0) return '0 GB';
  if (amount >= 10) return `${amount.toFixed(1).replace(/\.0$/, '')} GB`;
  if (amount >= 1) return `${amount.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')} GB`;
  return `${amount.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')} GB`;
}

export function formatUsd(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '$0.00';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
}

export function estimateCost(gb, pricePerGb) {
  const amount = Number(gb);
  const price = Number(pricePerGb);
  if (!Number.isFinite(amount) || !Number.isFinite(price) || amount <= 0 || price <= 0) return null;
  return amount * price;
}

export function countryLabel(code) {
  return String(code || '').trim().toUpperCase();
}

export function stateLabel(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.length <= 3) return text.toUpperCase();
  return text.replace(/(^|[\s_-])([a-z])/g, (_all, gap, letter) => `${gap}${letter.toUpperCase()}`);
}

export function billingHint(status) {
  if (!status || !status.connected) return '';
  if (status.billingReady) return '';
  if (!status.canBill) {
    return 'Add Data needs a key created with Billing enabled and a monthly spend cap. Default keys can generate lists and show remaining GB.';
  }
  return 'This key has no monthly spend cap, so ResiFactory will refuse charges. Create a new key with Billing enabled and a cap.';
}

export function generateBlockedReason(pool, status) {
  if (!status || !status.connected) return 'Link a ResiFactory key first.';
  if (!status.canGenerate) return 'This key cannot generate proxies. Recreate it with the default scopes.';
  if (!pool) return 'Choose a pool.';
  if (!pool.granted) return 'Unlock this pool on ResiFactory before generating.';
  if (pool.comingSoon) return 'This pool is not live yet.';
  if (pool.gb === 0) return 'This pool has no remaining GB.';
  return '';
}

export function emptyResiFactoryStatus() {
  return {
    connected: false,
    username: '',
    accountId: null,
    keyName: '',
    keyPrefix: '',
    keyLast4: '',
    scopes: [],
    canGenerate: false,
    canReadUsage: false,
    canReadPools: false,
    canBill: false,
    spendCapUsd: null,
    billingReady: false,
    developerUrl: DEVELOPER_URL,
    pools: [],
    pendingTopup: null,
    error: '',
  };
}
