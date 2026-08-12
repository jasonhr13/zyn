#!/usr/bin/env node
// Redsky DISCOVERY — plp_search_v2 with the mobile-APP channel identity.
// The Shape wall keys on channel identity, not the endpoint path: browser
// headers get captcha'd, app headers (x-channel-id: APPS + iOS UA) sail through.
//
// USAGE
//   node redsky-discovery-test.mjs                     # keyword search "pokemon"
//   KEYWORD="pokemon booster" PAGES=3 node redsky-discovery-test.mjs
//   CATEGORY=<node-after-N-> node redsky-discovery-test.mjs   # category listing

import { randomBytes } from 'node:crypto';

const KEY      = process.env.KEY      ?? '9f36aeafbe60771e321a7cc95a78140772ab3e96';
const KEYWORD  = process.env.KEYWORD  ?? (process.env.CATEGORY ? '' : 'pokemon');
const CATEGORY = process.env.CATEGORY ?? '';
const STORE_ID = process.env.STORE_ID ?? '875';
const COUNT    = Number(process.env.COUNT ?? 24);
const PAGES    = Number(process.env.PAGES ?? 2);
const visitorId = randomBytes(16).toString('hex').toUpperCase();

const APP_HEADERS = {
  accept: '*/*',
  'accept-language': 'en-US,en;q=0.9',
  'x-channel-id': 'APPS',
  'x-client-platform': 'iPhone',
  'x-client-version': '2026.28.0',
  'user-agent': 'Target/2026.28.0 iPhone15,2 iOS/26.4.1 CFNetwork/3860.500.112 Darwin/25.4.0',
};

const BASE = 'https://redsky.target.com/redsky_aggregations/v1/web/plp_search_v2';

function url(offset) {
  const p = new URLSearchParams({
    key: KEY,
    channel: 'APPS',
    count: String(COUNT),
    offset: String(offset),
    pricing_store_id: STORE_ID,
    store_id: STORE_ID,
    visitor_id: visitorId,
    zip: '20002',
    // "include out of stock" channel facet. Without this the search hides OOS
    // items and first-party product (mostly OOS) never appears — you get an
    // all-marketplace result. default_purchasability_filter alone is NOT enough.
    faceted_value: 'fwtfr',
  });
  if (CATEGORY) { p.set('category', CATEGORY); p.set('page', `/c/-/N-${CATEGORY}`); }
  else          { p.set('keyword', KEYWORD);   p.set('page', `/s/${KEYWORD}`); }
  return `${BASE}?${p}`;
}

const decode = (s) => (s ?? '').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&');

// Collectible Trading Cards. Filtering on this strips out apparel/toys/party
// goods that keyword and brand pages drag in. Set ITEM_TYPE="" to disable.
const TCG_ITEM_TYPE = '39980041';
const ITEM_TYPE = process.env.ITEM_TYPE ?? TCG_ITEM_TYPE;
// By default keep only Target-sold (first-party) items; Target Plus resellers
// are perpetually "in stock" and useless to a restock monitor. Set
// INCLUDE_MARKETPLACE=1 to see them too.
const INCLUDE_MARKETPLACE = process.env.INCLUDE_MARKETPLACE === '1';

function extract(json) {
  const search = json?.data?.search ?? {};
  const products = (search.products ?? []).map((p) => ({
    tcin: p?.tcin,
    title: decode(p?.item?.product_description?.title),
    price: p?.price?.current_retail ?? p?.price?.formatted_current_price,
    brand: p?.item?.primary_brand?.name,
    itemType: p?.item?.product_classification?.item_type?.type,
    marketplace: p?.item?.fulfillment?.is_marketplace === true,
    url: p?.item?.enrichment?.buy_url,
  }));
  const total = search?.search_response_metadata?.total_results
             ?? search?.metadata?.total_results
             ?? search?.total_results;
  return { products, total };
}

async function main() {
  console.log(`${CATEGORY ? `category=${CATEGORY}` : `keyword="${KEYWORD}"`}  visitor_id=${visitorId}\n`);
  const seen = new Map();
  let total;
  for (let i = 0; i < PAGES; i++) {
    const res = await fetch(url(i * COUNT), { headers: APP_HEADERS });
    const text = await res.text();
    if (!res.ok) { console.error(`HTTP ${res.status}: ${text.slice(0, 200)}`); process.exit(1); }
    const { products, total: t } = extract(JSON.parse(text));
    if (t != null) total = t;
    if (products.length === 0) break;
    for (const p of products) {
      if (!p.tcin || seen.has(p.tcin)) continue;
      if (ITEM_TYPE && p.itemType !== ITEM_TYPE) continue;      // Trading Cards only
      if (!INCLUDE_MARKETPLACE && p.marketplace) continue;      // first-party only
      seen.set(p.tcin, p);
    }
    if (i < PAGES - 1) await new Promise((r) => setTimeout(r, 400));
  }
  for (const p of seen.values()) {
    const src = p.marketplace ? 'MKT ' : 'TGT ';
    console.log(`${src}${p.tcin}  $${String(p.price ?? '—').padEnd(7)} ${(p.brand ?? '').padEnd(12).slice(0, 12)} ${p.title ?? ''}`);
  }
  const filt = [ITEM_TYPE ? 'Trading Cards' : null, INCLUDE_MARKETPLACE ? null : 'first-party only'].filter(Boolean).join(', ');
  console.log(`\n${seen.size} unique TCINs${filt ? ` (${filt})` : ''}.`);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
