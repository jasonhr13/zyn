#!/usr/bin/env node
// Probe candidate app-channel discovery endpoints. Goal: find a keyword/category
// search that returns products without the Shape wall, like the stock endpoint did.

import { randomBytes } from 'node:crypto';

const KEY      = '9f36aeafbe60771e321a7cc95a78140772ab3e96';
const KEYWORD  = process.env.KEYWORD ?? 'pokemon';
const STORE_ID = '875';
const visitorId = randomBytes(16).toString('hex').toUpperCase();

const APP_HEADERS = {
  accept: '*/*',
  'accept-language': 'en-US,en;q=0.9',
  'x-channel-id': 'APPS',
  'x-client-platform': 'iPhone',
  'x-client-version': '2026.28.0',
  'user-agent': 'Target/2026.28.0 iPhone15,2 iOS/26.4.1 CFNetwork/3860.500.112 Darwin/25.4.0',
};

const commonParams = {
  key: KEY,
  channel: 'APPS',
  count: '24',
  offset: '0',
  keyword: KEYWORD,
  page: `/s/${KEYWORD}`,
  pricing_store_id: STORE_ID,
  store_id: STORE_ID,
  visitor_id: visitorId,
  zip: '20002',
  default_purchasability_filter: 'true',
};

const CANDIDATES = [
  'v1/apps/plp_search_v2',
  'v2/apps/plp_search_v2',
  'v1/apps/plp_search_v1',
  'v1/apps/product_summary_search_v1',
  'v1/apps/search_results_v1',
  'v1/web/plp_search_v2',   // control — expected Shape-walled
];

// Products can live under a few shapes depending on endpoint version.
function countProducts(json) {
  const paths = [
    json?.data?.search?.products,
    json?.data?.product_summaries,
    json?.data?.search?.product_summaries,
    json?.data?.products,
  ];
  for (const p of paths) if (Array.isArray(p) && p.length) return { n: p.length, sample: p[0] };
  return { n: 0, sample: null };
}

function titleOf(p) {
  return p?.item?.product_description?.title ?? p?.title ?? '(?)';
}

async function probe(path) {
  const url = `https://redsky.target.com/redsky_aggregations/${path}?${new URLSearchParams(commonParams)}`;
  try {
    const res = await fetch(url, { headers: APP_HEADERS });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    const captcha = text.includes('captcha');
    const { n, sample } = json ? countProducts(json) : { n: 0, sample: null };
    let note = '';
    if (captcha) note = 'CAPTCHA/Shape wall';
    else if (n > 0) note = `✅ ${n} products — e.g. "${titleOf(sample)}"`;
    else if (json) note = `JSON but 0 products (keys: ${Object.keys(json?.data ?? json).join(',').slice(0, 80)})`;
    else note = `non-JSON: ${text.slice(0, 80)}`;
    console.log(`[${res.status}] ${path}\n      ${note}`);
  } catch (e) {
    console.log(`[ERR] ${path} — ${e.message}`);
  }
}

for (const c of CANDIDATES) {
  await probe(c);
  await new Promise((r) => setTimeout(r, 400)); // gentle spacing
}
