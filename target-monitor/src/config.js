// All runtime configuration comes from env. Secrets (proxies, webhooks) are set
// as Fly secrets; everything else has a sane default so the service boots bare.

const num = (v, d) => (v != null && v !== '' ? Number(v) : d);
const list = (v) => (v ? v.split(/[\n,]/).map((s) => s.trim()).filter(Boolean) : []);

const keywords = list(process.env.DISCOVERY_KEYWORDS);

export const config = {
  redsky: {
    key: process.env.REDSKY_KEY || '9f36aeafbe60771e321a7cc95a78140772ab3e96',
    storeId: process.env.STORE_ID || '875',
    zip: process.env.ZIP || '20002',
  },
  discovery: {
    keywords: keywords.length
      ? keywords
      : ['pokemon', 'pokemon elite trainer', 'pokemon booster bundle', 'pokemon booster box'],
    itemType: process.env.ITEM_TYPE || '39980041', // Collectible Trading Cards
    includeMarketplace: process.env.INCLUDE_MARKETPLACE === '1',
    intervalMs: num(process.env.DISCOVERY_INTERVAL_S, 300) * 1000,
    maxPages: num(process.env.DISCOVERY_MAX_PAGES, 8),
    pageSize: num(process.env.DISCOVERY_PAGE_SIZE, 24),
    delistAfterMisses: num(process.env.DELIST_AFTER_MISSES, 20),
  },
  fulfillment: {
    batchSize: num(process.env.BATCH_SIZE, 25),
    hotIntervalMs: num(process.env.HOT_INTERVAL_S, 3) * 1000,
    warmIntervalMs: num(process.env.WARM_INTERVAL_S, 30) * 1000,
    // After a state change, an item is polled hot for this long regardless of its
    // base tier, then reverts. So a cheap item that restocks still gets watched fast.
    warmAfterMs: num(process.env.WARM_AFTER_MIN, 60) * 60 * 1000,
  },
  restock: {
    // While a restocked item stays in stock, re-emit a "still in stock" ping on
    // this interval. 0 disables (transition-only). Only items we actually
    // announced (OOS -> in) re-ping — never baseline-in-stock items.
    repingIntervalMs: num(process.env.RESTOCK_REPING_INTERVAL_S, 60) * 1000,
    repingMax: num(process.env.RESTOCK_REPING_MAX, 0), // 0 = unlimited re-pings
  },
  tiers: {
    // High-demand formats are pinned hot; everything else defaults to warm.
    hotTitleRegex:
      process.env.HOT_TITLE_REGEX ||
      'elite trainer|booster bundle|booster box|booster display|premium collection|ultra[- ]?premium|super premium|display',
    hotMinPrice: num(process.env.HOT_MIN_PRICE, 40),
  },
  heartbeat: {
    url: process.env.OPS_DISCORD_WEBHOOK_URL || '',
    intervalMs: num(process.env.HEALTH_INTERVAL_S, 1800) * 1000,
  },
  proxies: list(process.env.PROXY_URLS),
  // Explicit TCINs to watch regardless of discovery — for pre-launch SKUs that
  // aren't in Target's search catalog yet. Polled hot; alerts fire the moment
  // they go live. See launch-watch logic in fulfillment.js.
  seedTcins: list(process.env.SEED_TCINS),
  // TCINs that must never ping Discord/webhooks. Discovery still sees them, but
  // they are not enrolled, polled, or emitted. Ignore wins over SEED_TCINS.
  ignoredTcins: list(process.env.IGNORED_TCINS),
  pacing: { maxRequestsPerMin: num(process.env.MAX_RPM, 600) },
  brand: {
    name: process.env.BRAND_NAME || 'Zyn',
    color: parseInt((process.env.BRAND_COLOR || 'C9A227').replace(/^#|^0x/i, ''), 16),
    iconUrl: process.env.BRAND_ICON_URL || '',
    footer: process.env.BRAND_FOOTER || 'Zyn Monitors',
    cartLimit: process.env.CART_LIMIT || 'N/A',
    appLinkLabel: process.env.APP_LINK_LABEL || 'Click Me',
  },
  sinks: {
    http: process.env.WEBHOOK_URL
      ? {
          url: process.env.WEBHOOK_URL,
          hmacSecret: process.env.WEBHOOK_HMAC_SECRET || '',
          events: list(process.env.WEBHOOK_EVENTS).length ? list(process.env.WEBHOOK_EVENTS) : ['*'],
        }
      : null,
    discord: process.env.DISCORD_WEBHOOK_URL
      ? {
          url: process.env.DISCORD_WEBHOOK_URL,
          events: list(process.env.DISCORD_EVENTS).length
            ? list(process.env.DISCORD_EVENTS)
            : ['stock.online.in', 'preorder.live', 'stock.online.reping', 'product.launched'],
        }
      : null,
  },
  dbPath: process.env.DB_PATH || './data/monitor.db',
  port: num(process.env.PORT, 8080),
  adminToken: process.env.ADMIN_TOKEN || '',
  logLevel: process.env.LOG_LEVEL || 'info',
};

export const ignoredTcinSet = new Set(config.ignoredTcins.map(String));
export const isIgnoredTcin = (tcin) => ignoredTcinSet.has(String(tcin));
