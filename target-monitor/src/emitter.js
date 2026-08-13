import { createHmac } from 'node:crypto';
import { fetch } from 'undici';
import { config } from './config.js';
import { insertEvent, markEmitted, recordFailure } from './db.js';
import { log } from './log.js';

const RETRIES = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Canonical event → 1-minute idempotency bucket. Dedupes rapid double-fires and
// restart re-emits without suppressing a genuine later re-transition.
function idemKey(type, tcin, current) {
  // seq (re-ping sequence) makes each still-in-stock ping unique; otherwise fall
  // back to status/price + a 1-minute bucket to dedupe accidental double-fires.
  const sig = current?.seq ?? current?.status ?? current?.price ?? '';
  return `${tcin}:${type}:${sig}:${Math.floor(Date.now() / 60000)}`;
}

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

async function withRetry(sink, eventId, fn) {
  let lastErr;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      await fn();
      return true;
    } catch (err) {
      lastErr = err;
      if (attempt < RETRIES) await sleep(250 * 2 ** (attempt - 1));
    }
  }
  recordFailure(sink, eventId, RETRIES, lastErr); // dead-letter
  log.error({ sink, eventId, err: String(lastErr) }, 'sink delivery failed');
  return false;
}

// event type -> the "Type" label shown in the embed
const TYPE_LABEL = {
  'stock.online.in': 'Restock',
  'stock.online.reping': 'Restock',
  'preorder.live': 'Preorder',
  'stock.online.out': 'Out of Stock',
  'price.changed': 'Price Change',
  'product.launched': 'Launched',
  'product.discovered': 'New Product',
  'product.delisted': 'Delisted',
};
const NEGATIVE = new Set(['stock.online.out', 'product.delisted']);

// Target's app cap: quantities >= 10 are reported as "10+".
function stockLabel(qty) {
  if (qty == null) return 'N/A';
  if (qty <= 0) return 'OOS';
  return qty >= 10 ? '10+' : String(qty);
}

function discordEmbed(e) {
  const { brand } = config;
  const openUrl = e.url || `https://www.target.com/p/-/A-${e.tcin}`;
  const price = e.price != null ? `$${e.price}` : 'N/A';
  return {
    username: brand.name,
    avatar_url: brand.iconUrl || undefined,
    embeds: [
      {
        title: e.title || String(e.tcin),
        url: openUrl,
        color: NEGATIVE.has(e.event) ? 0xed4245 : brand.color,
        thumbnail: e.image ? { url: e.image } : undefined,
        fields: [
          { name: 'Price', value: price, inline: true },
          { name: 'Type', value: TYPE_LABEL[e.event] ?? e.event, inline: true },
          { name: 'Tcin', value: String(e.tcin), inline: true },
          { name: 'Total Stock', value: stockLabel(e.current?.qty), inline: true },
          { name: 'Open In App', value: `[${brand.appLinkLabel}](${openUrl})`, inline: true },
          { name: 'Cart Limit', value: brand.cartLimit, inline: true },
        ],
        footer: { text: brand.footer, icon_url: brand.iconUrl || undefined },
        timestamp: new Date(e.observed_at).toISOString(),
      },
    ],
  };
}

const matchesFilter = (filters, type) =>
  !filters || filters.some((f) => f === '*' || f === type || (f.endsWith('.*') && type.startsWith(f.slice(0, -1))));

export function makeEmitter() {
  const { http, discord } = config.sinks;

  return async function emit(type, product, { previous, current } = {}) {
    const observed_at = Date.now();
    const idem = idemKey(type, product.tcin, current);
    const payload = {
      event: type,
      tcin: product.tcin,
      title: product.title ?? null,
      url: product.url ?? null,
      image: product.image ?? null,
      price: current?.price ?? product.price ?? null,
      previous: previous ?? null,
      current: current ?? null,
      store_context: { store_id: config.redsky.storeId, zip: config.redsky.zip },
      observed_at,
    };

    const eventId = insertEvent({ idem, type, tcin: product.tcin, payload });
    if (!eventId) return; // duplicate — already handled

    log.info({ type, tcin: product.tcin, title: product.title }, 'event');

    const body = JSON.stringify(payload);
    const deliveries = [];
    if (http && matchesFilter(http.events, type)) {
      const headers = {};
      if (http.hmacSecret) headers['x-signature'] = createHmac('sha256', http.hmacSecret).update(body).digest('hex');
      deliveries.push(withRetry('http', eventId, () => postJson(http.url, body, headers)));
    }
    if (discord && matchesFilter(discord.events, type)) {
      deliveries.push(withRetry('discord', eventId, () => postJson(discord.url, JSON.stringify(discordEmbed(payload)))));
    }

    if (deliveries.length === 0 || (await Promise.all(deliveries)).some(Boolean)) markEmitted(eventId);
  };
}
