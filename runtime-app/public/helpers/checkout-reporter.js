// Central checkout reporting — one place for BOTH sides of "who bought what":
//   1. POST /api/checkout on the dashboard  → the user's Home page history + Spent
//   2. the global Discord webhook           → your collector channel, tagged with Buyer
//   3. the public Discord webhook           → Target/Pokémon success only, no buyer/account/order
//
// Why this lives in the Electron main process rather than in each engine: Target
// and Walmart are a COMPILED Go binary that posts its own embeds and only accepts
// a webhook URL — there is no way to add a Buyer field inside it. P-Bandai is a
// separate bundled ESM engine that can't require() from here. Main is the only
// process that sees every module's checkout events AND holds the license identity,
// so centralising here is what makes the tagging uniform across modules.
//
// Fail-soft everywhere: a reporting outage must never interrupt a checkout run.

const https = require('https');
const { URL } = require('url');

const DASHBOARD = 'https://secret-lair-dashboard.vercel.app';

// Global collector so every tester's orders land in one channel. Hardcoded on
// purpose so it ships in the build (same value the P-Bandai engine uses — keep
// them in sync, and rotate BOTH if it is ever abused).
const GLOBAL_WEBHOOK = '__ZYN_GLOBAL_CHECKOUT_WEBHOOK__';
const PUBLIC_WEBHOOK = '__ZYN_PUBLIC_CHECKOUT_WEBHOOK__';
const ZYN_AVATAR = 'https://zynbot.app/zyn-icon.png';
const PUBLIC_SITES = new Set(['target', 'pokemoncenter']);

// Set once the license claim resolves (electron.js → configure()).
let ctx = { key: '', token: '', discord: '', discordId: '', log: () => {} };

function configure(next) {
  ctx = { ...ctx, ...next };
}

function postJson(urlStr, body, timeoutMs = 6000) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(urlStr); } catch { return resolve(null); }
    const data = JSON.stringify(body);
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
      },
      (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }
    );
    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs, () => req.destroy());
    req.write(data);
    req.end();
  });
}

// Duplicate suppression: engines can re-emit the same result for the same item
// (a retry loop, a re-render, a reconnect). Without this the collector channel
// gets spammed and Spent double-counts. Keyed on the whole event, 60s window.
const recent = new Map();
function isDuplicate(sig) {
  const now = Date.now();
  for (const [k, t] of recent) if (now - t > 60000) recent.delete(k);
  if (recent.has(sig)) return true;
  recent.set(sig, now);
  return false;
}

// site      — 'target' | 'walmart' | 'pbandai' | …  (shown in the embed)
// status    — 'success' | 'failed'
// product   — human name or SKU
// price     — number (drives the dashboard's Spent hero)
// account   — the site login used (masked in Discord with spoiler bars)
// order     — order number when the engine gives us one
// sku       — TCIN / PID, so a row can be traced back to the item
// url       — product link; becomes the embed title's href
// source    — harvester that minted the Shape cookie used ('chrome'|'msedge'|'chromium'|'extension').
//             GLOBAL COLLECTOR ONLY: it is operator telemetry, and means nothing to the user whose
//             own webhook this never reaches.
// image     — product image URL for the public thumbnail; omitted when missing or not https
// size      — public Size field; Target/Pokémon often have none, so the public embed uses Default
async function report({ site, status, product, price, account, order, qty, sku, url, source, image, size }) {
  const ok = status === 'success';
  const sig = [site, status, product, order, account].join('|');
  if (isDuplicate(sig)) return;

  // ── 1. dashboard analytics ──────────────────────────────────────────────
  if (ctx.key) {
    await postJson(`${DASHBOARD}/api/checkout`, {
      key: ctx.key,
      token: ctx.token || undefined,
      status: ok ? 'success' : 'failed',
      product: product || '',
      price: Number(price) || 0,
      account: account || '',
      order: order || '',
      site: site || '',
    });
  }

  // ── 2. global collector webhook ─────────────────────────────────────────
  // Same layout as the engine's own checkout embed (bot-base/task/webhook/checkout.go): the product
  // name is the title rather than a "Product" field, and the rows read
  // Result/Site/Buyer, then SKU, then Qty/Price Per/Grand Total. Kept deliberately in step so one
  // habit reads both channels.
  const total = Number(price) || 0;
  const n = Number(qty) || 1;
  const fields = [
    { name: 'Result', value: ok ? 'Success' : 'Failed', inline: true },
    { name: 'Site', value: String(site || 'unknown'), inline: true },
    // A real <@id> mention, not a bare name.
    //
    // The point of this channel is knowing WHO checked out and being able to reach them; a plain
    // username is neither clickable nor notifiable, and Discord usernames change. The numeric id
    // does not, and it renders as a live mention in the embed. Falls back to the username when the
    // dashboard has no id on file, and to a dash when it has neither.
    {
      name: 'Buyer',
      value: ctx.discordId
        ? `<@${String(ctx.discordId).replace(/\D/g, '')}>`
        : (ctx.discord ? String(ctx.discord).slice(0, 60) : '—'),
      inline: true,
    },
  ];
  if (sku) fields.push({ name: 'SKU', value: `\`${String(sku).slice(0, 60)}\`` });
  fields.push(
    { name: 'Qty', value: String(n), inline: true },
    { name: 'Price Per', value: total > 0 ? `$${(total / n).toFixed(2)}` : '—', inline: true },
    { name: 'Grand Total', value: total > 0 ? `$${total.toFixed(2)}` : '—', inline: true },
  );
  if (source) fields.push({ name: 'Cookie', value: String(source).slice(0, 24), inline: true });
  fields.push({ name: 'Account', value: account ? `||${String(account).slice(0, 60)}||` : '—' });
  fields.push({ name: 'Order Number', value: order ? `||${String(order).slice(0, 60)}||` : '—' });

  // Target returns product names HTML-escaped, so this channel was showing "Pok&#233;mon" verbatim.
  const title = String(product || 'Checkout')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .slice(0, 256);

  await postJson(GLOBAL_WEBHOOK, {
    embeds: [
      {
        title,
        ...(url ? { url } : {}),
        color: ok ? 0x34ca6e : 0xfb5454,
        fields,
        timestamp: new Date().toISOString(),
      },
    ],
  });

  // Public success board. Anyone in the server can see this, so it must not carry Buyer, account,
  // order, cookie source, or a product URL that is otherwise unused. Target and Pokémon Center only.
  const publicSite = String(site || '').toLowerCase();
  if (!ok || !PUBLIC_SITES.has(publicSite)) return;
  const siteLabel = publicSite === 'pokemoncenter' ? 'Pokémon Center' : 'Target';
  const publicFields = [
    { name: 'Product', value: `• ${n}x ${title}`.slice(0, 1024) },
    { name: 'Price', value: total > 0 ? `$${total.toFixed(2)}` : '—', inline: true },
    { name: 'Size', value: String(size || 'Default').slice(0, 60), inline: true },
    { name: 'Site', value: siteLabel, inline: true },
  ];
  const thumb = String(image || '').trim();
  await postJson(PUBLIC_WEBHOOK, {
    username: 'Zyn',
    avatar_url: ZYN_AVATAR,
    embeds: [
      {
        title: 'Successful Checkout :tada:',
        color: 0x34ca6e,
        fields: publicFields,
        footer: { text: 'Zyn', icon_url: ZYN_AVATAR },
        timestamp: new Date().toISOString(),
        ...( /^https:\/\//i.test(thumb) ? { thumbnail: { url: thumb.slice(0, 500) } } : {}),
      },
    ],
  });
}

module.exports = { configure, report, DASHBOARD };
