#!/usr/bin/env node
// Redsky stock check — mobile-APP channel (the one that isn't Shape-protected).
// This is the endpoint Polar's monitor uses. Plain fetch works; no TLS
// impersonation, cookies, or captcha solving needed for reads.
//
// USAGE
//   node redsky-stock-test.mjs                       # checks a default Pokemon TCIN
//   TCINS=88897904,1004304 node redsky-stock-test.mjs
//
// At real polling frequency you'll still want a TLS-impersonating client +
// rotating proxies to avoid per-IP rate limits — but that's durability, not a
// requirement to get data. This bare version is the correctness canary.

const KEY      = process.env.KEY      ?? '9f36aeafbe60771e321a7cc95a78140772ab3e96';
const TCINS    = (process.env.TCINS   ?? '88897904').split(',').map((s) => s.trim()).filter(Boolean);
const STORE_ID = process.env.STORE_ID ?? '875';

const BASE = 'https://redsky.target.com/redsky_aggregations/v1/apps/tcin_product_list_v2';

// iOS-app headers — this identity is what routes around Shape. The device/visitor
// values are cosmetic (Target doesn't validate them on reads); keep them plausible.
const APP_HEADERS = {
  accept: '*/*',
  'accept-language': 'en-US,en;q=0.9',
  'x-channel-id': 'APPS',
  'x-client-platform': 'iPhone',
  'x-client-version': '2026.28.0',
  'user-agent': 'Target/2026.28.0 iPhone15,2 iOS/26.4.1 CFNetwork/3860.500.112 Darwin/25.4.0',
};

const IN_STOCK = new Set(['IN_STOCK', 'PRE_ORDER_SELLABLE']);

function url(tcins) {
  const p = new URLSearchParams({
    key: KEY,
    pricing_store_id: STORE_ID,
    store_id: STORE_ID,
    tcins: tcins.join(','),
  });
  return `${BASE}?${p}`;
}

function summarize(s) {
  const ship = s?.fulfillment?.shipping_options ?? {};
  const status = ship.availability_status ?? 'UNKNOWN';
  return {
    tcin: s?.tcin,
    title: s?.item?.product_description?.title,
    price: s?.price?.current_retail,
    status,
    qty: ship.available_to_promise_quantity,
    inStock: IN_STOCK.has(status),
    url: s?.item?.enrichment?.buy_url,
  };
}

async function main() {
  const res = await fetch(url(TCINS), { headers: APP_HEADERS });
  const text = await res.text();
  if (!res.ok) {
    console.error(`HTTP ${res.status} — ${text.slice(0, 300)}`);
    process.exit(1);
  }
  const json = JSON.parse(text);
  const summaries = json?.data?.product_summaries ?? [];
  const errors = json?.errors ?? json?.data?.errors ?? [];

  for (const s of summaries.map(summarize)) {
    const flag = s.inStock ? '🟢 IN STOCK' : '🔴 OOS     ';
    const qty = s.qty != null ? ` qty=${s.qty}` : '';
    console.log(`${flag} ${s.tcin}  $${String(s.price ?? '—').padEnd(6)} [${s.status}${qty}]  ${s.title ?? ''}`);
  }
  if (errors.length) console.log(`\nunresolved tcins: ${JSON.stringify(errors).slice(0, 200)}`);
  console.log(`\n${summaries.length}/${TCINS.length} resolved.`);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
