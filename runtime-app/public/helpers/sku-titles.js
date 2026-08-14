// Product names for the Target watch list.
//
// A watch list is eight bare TCINs. Nothing on screen says which is the Booster Bundle and which is
// the Super Premium Collection, so deciding "should this one still be in the list" means opening
// target.com and pasting numbers one at a time. The engine has known these names all along — the
// monitor reads them out of the same redsky response it uses for stock — they were simply never
// kept anywhere the UI could reach.
//
// This module only STORES them. Fetching is the engine's job: redsky fingerprints the TLS
// handshake, so a lookup from Electron is refused with 403 + a captcha body no matter which proxy
// carries it (measured against a clean residential exit — refused exactly like the home IP). The
// monitor parses these titles out of the poll it already makes and pushes them over the bridge.
//
// Cached to disk and treated as permanent: a TCIN's title does not change, and a name that had to
// wait for the monitor's first poll would be blank for the opening seconds of every session, which
// is exactly when the watch list is being read.

// Lazy: data-manager reaches for Electron's app at require time, and nothing about storing or
// shortening a product title needs Electron. Deferring it keeps this module loadable — and
// therefore testable — outside the main process.
function store() { return require('./data-manager'); }

// Titles arrive as "Pokémon Trading Card Game: Scarlet & Violet—Prismatic Evolutions Booster
// Bundle". In a list of eight, the first four words are identical on every row and the part that
// actually tells them apart is pushed off the end. Strip the franchise lead-in, keep what
// distinguishes.
// redsky returns titles HTML-escaped: "Pok&#233;mon", "Scarlet &#38; Violet&#8212;Prismatic".
// Rendered raw those read as gibberish, and they also defeat the prefix stripping below, because
// "Pok&#233;mon Trading Card Game:" does not match a pattern looking for "Pokemon".
function decodeEntities(str) {
  return String(str || '')
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(parseInt(d, 10)); } catch { return _; } })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return _; } })
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&(?:apos|#39);/g, "'")
    .replace(/&nbsp;/g, ' ');
}

// Lead-ins that repeat on every row of a Pokémon watch list and so distinguish nothing. Applied in
// a loop rather than in sequence: a title can carry several stacked ("Pokémon Trading Card Game:
// Scarlet & Violet—Prismatic Evolutions..."), and stripping one exposes the next.
const NOISE_PREFIXES = [
  /^pok[e\u00e9]mon\s+(?:trading\s+card\s+game|tcg)[\s:\-\u2013\u2014]*/i,
  /^(?:trading\s+card\s+game|tcg)[\s:\-\u2013\u2014]*/i,
  /^pok[e\u00e9]mon[\s:\-\u2013\u2014]*/i,
  /^scarlet\s*&\s*violet[\s:\-\u2013\u2014]*/i,
  /^mega\s+evolution[\s:\-\u2013\u2014]*/i,
];

function shorten(title) {
  let s = decodeEntities(title).trim();
  if (!s) return '';
  // Up to and including the first colon, when it is short enough to be a brand prefix rather than
  // part of the product name itself.
  const colon = s.indexOf(':');
  if (colon > 0 && colon <= 40) s = s.slice(colon + 1).trim();

  // Keep stripping until nothing matches. Bounded so a pathological title cannot spin here.
  for (let pass = 0; pass < NOISE_PREFIXES.length + 2; pass++) {
    const before = s;
    for (const re of NOISE_PREFIXES) s = s.replace(re, '');
    s = s.trim();
    if (s === before) break;
  }
  // Never return empty: a title that is nothing BUT prefixes is more useful shown whole than blank.
  return s.trim() || decodeEntities(title).trim();
}

function readCache() {
  try {
    const s = store().getSettings() || {};
    return (s.targetSkuTitles && typeof s.targetSkuTitles === 'object') ? s.targetSkuTitles : {};
  } catch { return {}; }
}

function writeCache(map) {
  try {
    const s = store().getSettings() || {};
    store().saveSettings({ ...s, targetSkuTitles: map });
  } catch { /* a cache that cannot be written is a slow lookup, not a broken one */ }
}

// Re-shortened on read. Entries cached by an earlier build were run through a weaker filter (no
// entity decoding, fewer prefixes), and those would otherwise sit there looking wrong until the
// monitor happened to re-send them. shorten() is safe to re-apply — it only ever removes lead-ins.
function getTitles() {
  const out = {};
  for (const [k, v] of Object.entries(readCache())) out[k] = shorten(v);
  return out;
}

// Titles pushed up from the engine. Returns the merged map when something actually changed, or
// null when it is all already known — so the caller can skip a pointless round trip to the UI.
function mergeTitles(incoming) {
  const cache = readCache();
  let changed = false;
  const next = { ...cache };
  for (const [tcin, raw] of Object.entries(incoming || {})) {
    const title = shorten(raw);
    const id = String(tcin || '').trim();
    if (!id || !title || next[id] === title) continue;
    next[id] = title;
    changed = true;
  }
  if (!changed) return null;
  writeCache(next);
  return next;
}

module.exports = { getTitles, mergeTitles, shorten };
