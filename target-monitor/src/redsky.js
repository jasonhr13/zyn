import { fetch } from 'undici';
import { randomBytes } from 'node:crypto';
import { config } from './config.js';
import { proxyPool } from './proxy.js';
import { pace } from './pacer.js';
import { log } from './log.js';

// Mobile-app channel identity. This is what routes around Shape — browser
// headers get captcha'd, app headers return data. See the repo test scripts.
const APP_HEADERS = {
  accept: '*/*',
  'accept-language': 'en-US,en;q=0.9',
  'accept-encoding': 'gzip, deflate, br',
  'x-channel-id': 'APPS',
  'x-client-platform': 'iPhone',
  'x-client-version': '2026.28.0',
  'user-agent': 'Target/2026.28.0 iPhone15,2 iOS/26.4.1 CFNetwork/3860.500.112 Darwin/25.4.0',
};

const IN_STOCK = new Set(['IN_STOCK', 'PRE_ORDER_SELLABLE']);
const AGG = 'https://redsky.target.com/redsky_aggregations/v1';

export class SoftBlock extends Error {}

const decode = (s) =>
  (s ?? '').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&');
const visitorId = () => randomBytes(16).toString('hex').toUpperCase();

async function getJson(url, { allow404 = false } = {}) {
  await pace();
  const lease = proxyPool.lease();
  let res;
  try {
    res = await fetch(url, { headers: APP_HEADERS, dispatcher: lease.dispatcher });
  } catch (err) {
    lease.mark(false);
    throw err;
  }
  const text = await res.text();
  if (res.status === 403 && text.includes('captcha')) {
    lease.mark(false);
    throw new SoftBlock(`captcha via ${lease.proxy}`);
  }
  // A stock batch of only-unknown TCINs (e.g. pre-launch seeds) returns 404 with
  // a JSON error body — the request itself succeeded, so don't penalize the proxy.
  if (res.status === 404 && allow404) {
    lease.mark(true);
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  }
  if (!res.ok) {
    lease.mark(false);
    throw new Error(`HTTP ${res.status}`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    lease.mark(false);
    throw new SoftBlock(`non-JSON body (${text.slice(0, 60)})`);
  }
  lease.mark(true);
  return json;
}

// ---- Discovery (plp_search_v2, app channel) ----------------------------------

function searchUrl(keyword, offset) {
  const p = new URLSearchParams({
    key: config.redsky.key,
    channel: 'APPS',
    count: String(config.discovery.pageSize),
    offset: String(offset),
    keyword,
    page: `/s/${keyword}`,
    pricing_store_id: config.redsky.storeId,
    store_id: config.redsky.storeId,
    visitor_id: visitorId(),
    zip: config.redsky.zip,
    faceted_value: 'fwtfr', // include out of stock — required or first-party is hidden
  });
  return `${AGG}/web/plp_search_v2?${p}`;
}

function parseSearchProducts(json) {
  return (json?.data?.search?.products ?? []).map((p) => ({
    tcin: p?.tcin,
    title: decode(p?.item?.product_description?.title),
    price: p?.price?.current_retail ?? null,
    brand: p?.item?.primary_brand?.name ?? null,
    image: p?.item?.enrichment?.images?.primary_image_url ?? null,
    url: p?.item?.enrichment?.buy_url ?? null,
    itemType: p?.item?.product_classification?.item_type?.type ?? null,
    marketplace: p?.item?.fulfillment?.is_marketplace === true,
  }));
}

// Returns a Map(tcin -> product) of enrollable products across all seed keywords.
export async function discover() {
  const { keywords, maxPages, pageSize, itemType, includeMarketplace } = config.discovery;
  const out = new Map();
  for (const keyword of keywords) {
    for (let page = 0; page < maxPages; page++) {
      let rows;
      try {
        rows = parseSearchProducts(await getJson(searchUrl(keyword, page * pageSize)));
      } catch (err) {
        log.warn({ keyword, page, err: err.message }, 'discovery page failed');
        break;
      }
      if (rows.length === 0) break;
      for (const r of rows) {
        if (!r.tcin || out.has(r.tcin)) continue;
        if (itemType && r.itemType !== itemType) continue;
        if (!includeMarketplace && r.marketplace) continue;
        out.set(r.tcin, r);
      }
    }
  }
  return out;
}

// ---- Stock (tcin_product_list_v2, app channel) -------------------------------

function stockUrl(tcins) {
  const p = new URLSearchParams({
    key: config.redsky.key,
    pricing_store_id: config.redsky.storeId,
    store_id: config.redsky.storeId,
    tcins: tcins.join(','),
  });
  return `${AGG}/apps/tcin_product_list_v2?${p}`;
}

function parseSummary(s) {
  const ship = s?.fulfillment?.shipping_options ?? {};
  const status = ship.availability_status ?? 'UNKNOWN';
  return {
    tcin: s?.tcin,
    title: decode(s?.item?.product_description?.title),
    url: s?.item?.enrichment?.buy_url ?? null,
    image: s?.item?.enrichment?.images?.primary_image_url ?? null,
    status,
    purchasable: IN_STOCK.has(status),
    price: s?.price?.current_retail ?? null,
    qty: ship.available_to_promise_quantity ?? null,
  };
}

// Fetch one batch of up to ~25 TCINs. Returns { summaries, missing }.
export async function fetchStock(tcins) {
  const json = await getJson(stockUrl(tcins), { allow404: true });
  const summaries = (json?.data?.product_summaries ?? []).map(parseSummary).filter((s) => s.tcin);
  const resolved = new Set(summaries.map((s) => s.tcin));
  const missing = tcins.filter((t) => !resolved.has(t));
  return { summaries, missing };
}
