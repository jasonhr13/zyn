// Turn a Discord monitor embed into something Zyn can act on.
//
// Two feeds, two shapes. Written against real posts captured 2026-07-29:
//
//   #target  — "Mega Notify : Powered by Zoro & NS"
//     title  = product name (hyperlinked to the PDP)
//     fields = Price | Type | Tcin | Total Stock | Open In App | Cart Limit
//
//   #bandai  — "The Lab"
//     title  = product name (hyperlinked)
//     fields = Price | Type | PID | Cart Limit | Release Time
//
// Routing is by CHANNEL first, because that is the one thing the poster cannot get wrong, with the
// SKU field name as a cross-check. A Tcin appearing in the bandai channel means the feed changed or
// somebody reposted, and buying against a mis-routed SKU is worse than not buying — so it refuses.

// Discord field names are matched case- and space-insensitively: monitors reformat their own labels
// ("Tcin" -> "TCIN", "Cart Limit" -> "CartLimit") far more often than they change what they mean.
const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[\s_-]+/g, '');

function fieldMap(embed) {
  const out = {};
  for (const f of (embed && embed.fields) || []) {
    const k = norm(f.name);
    if (k) out[k] = String(f.value == null ? '' : f.value).trim();
  }
  return out;
}

// Discord wraps values in markdown and code spans; strip to the bare token.
const bare = (v) => String(v || '')
  .replace(/```[a-z]*|`|\*\*|__|~~/g, '')
  .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')   // [text](url) -> text
  .trim();

const SITES = {
  target: {
    site: 'target',
    label: 'Target',
    skuFields: ['tcin'],
    // A TCIN is all digits. Rejecting anything else stops a reformatted embed from feeding the engine
    // a product NAME as a SKU, which would otherwise sail through and quietly never match stock.
    skuOk: (s) => /^\d{6,12}$/.test(s),
  },
  pbandai: {
    site: 'pbandai',
    label: 'P-Bandai',
    skuFields: ['pid', 'productcode', 'sku'],
    // P-Bandai codes look like N2903432004 — a letter then digits.
    skuOk: (s) => /^[A-Z]{1,3}\d{6,12}$/i.test(s),
  },
};

// channelId -> site, from Settings. Anything not listed is ignored outright: a monitor for a site we
// have no engine for must not silently produce a task that cannot run.
function siteForChannel(channelId, channelMap) {
  const hit = (channelMap || {})[String(channelId)];
  return hit && SITES[hit] ? SITES[hit] : null;
}

// The URL is the LEAST trustworthy thing on these embeds. Mega Notify's "Open In App" points at a
// zephr… redirector rather than target.com, and The Lab ships a spoilered field holding a discord.com
// link. So a URL is captured for display only — never for routing or for deriving a SKU. Prefer the
// retailer's own domain when one is present, so the operator sees a PDP rather than a tracker.
const RETAILER_HOST = /(^|\.)(target\.com|p-bandai\.com)$/i;

function firstUrl(embed) {
  const candidates = [];
  if (embed && embed.url) candidates.push(embed.url);
  const f = fieldMap(embed);
  for (const key of ['openinapp', 'link', 'product', 'url']) {
    const m = /\((https?:\/\/[^)]+)\)/.exec(String(f[key] || ''));
    if (m) candidates.push(m[1]);
    else if (/^https?:\/\//.test(String(f[key] || '').trim())) candidates.push(String(f[key]).trim());
  }
  for (const u of candidates) {
    try { if (RETAILER_HOST.test(new URL(u).hostname)) return u; } catch {}
  }
  return candidates[0] || '';
}

// Discord renders <t:1785310200> and <t:1785310200:f> as a localised date; raw it is a Unix second.
// Storing the token verbatim would put "<t:1785310200>" in front of the operator, and a P-Bandai
// pre-order's release time is the one field worth acting on.
function readTimestamp(v) {
  const s = bare(v);
  const m = /^<t:(\d+)(?::[a-zA-Z])?>$/.exec(s);
  if (!m) return s || null;
  const d = new Date(Number(m[1]) * 1000);
  return isNaN(d.getTime()) ? s : d.toISOString();
}

// Returns { ok, site, label, sku, name, url, price, cartLimit, stock, type } or { ok:false, why }.
function parseMonitorEmbed(embed, channelId, channelMap) {
  const cfg = siteForChannel(channelId, channelMap);
  if (!cfg) return { ok: false, why: 'channel is not mapped to a supported site' };
  if (!embed) return { ok: false, why: 'message carried no embed' };

  const f = fieldMap(embed);

  let sku = '';
  for (const key of cfg.skuFields) {
    if (f[key]) { sku = bare(f[key]); break; }
  }
  if (!sku) return { ok: false, why: `no ${cfg.skuFields[0]} field on the embed` };
  if (!cfg.skuOk(sku)) {
    // Cross-check failure: right channel, wrong-looking identifier.
    return { ok: false, why: `"${sku}" does not look like a ${cfg.label} SKU` };
  }
  // The other site's identifier appearing here means a mis-routed or reposted embed.
  for (const [other, o] of Object.entries(SITES)) {
    if (other === cfg.site) continue;
    for (const k of o.skuFields) {
      if (f[k]) return { ok: false, why: `embed carries a ${o.label} ${k.toUpperCase()} in the ${cfg.label} channel` };
    }
  }

  const limit = parseInt(bare(f['cartlimit'] || f['limit'] || ''), 10);
  const stock = parseInt(bare(f['totalstock'] || f['stock'] || ''), 10);

  return {
    ok: true,
    site: cfg.site,
    label: cfg.label,
    sku,
    name: bare((embed.title || '')).slice(0, 160),
    url: firstUrl(embed),
    price: bare(f['price'] || '') || 'N/A',
    type: bare(f['type'] || '') || 'Unknown',
    cartLimit: Number.isFinite(limit) && limit > 0 ? limit : null,
    stock: Number.isFinite(stock) && stock >= 0 ? stock : null,
    releaseTime: readTimestamp(f['releasetime'] || ''),
  };
}

module.exports = { parseMonitorEmbed, SITES, fieldMap, bare, norm, firstUrl, readTimestamp };
