// ── Beta license gate ──────────────────────────────────────────────────────────
// Keys are validated against a manifest hosted at a URL YOU control. Flipping "active" to
// false there (or letting "expires" pass) revokes the key for everyone on their next check —
// that remote lookup is the ONLY reason revocation is possible at all. A key checked purely
// on the user's machine could never be taken back.
//
// The URL is hardcoded on purpose: if it were a setting, a tester could point the app at
// their own manifest and self-authorize.
//
// HONEST LIMITS — this is a courtesy lock for a friends beta, not DRM:
//  • public/ ships into app.asar as plain JS. Anyone can `npx asar extract` and delete this check.
//  • The engine bundle is minified, not encrypted (bytecode breaks Playwright's page.evaluate).
// It reliably stops casual continued use after you revoke. It will not stop someone determined.
//
// Manifest format (keys are matched case-insensitively):
// {
//   "keys": {
//     "deathwish": { "active": true, "expires": "2026-09-01", "note": "public beta" }
//   }
// }
const https = require('https');

// Secret gist owned by z04231992. The raw URL (no revision SHA) always serves the LATEST
// revision, so editing the gist revokes keys immediately — do not pin a SHA here.
const LICENSE_URL = 'https://gist.githubusercontent.com/z04231992/0a5efde1be0152cea2a58cf8008d126e/raw/licenses.json';

// New license authority: the Supabase dashboard (keys created/disabled on its Admin page). Checked
// FIRST; the gist above stays as a fallback so legacy keys keep working during the migration.
const DASHBOARD_URL = 'https://secret-lair-dashboard.vercel.app';

const CHECK_TTL_MS = 30 * 60 * 1000;      // re-check at most every 30 min while running
const GRACE_MS     = 6 * 60 * 60 * 1000;  // tolerate this long offline after a good check

let cache = { ok: false, reason: 'unchecked', at: 0, lastGood: 0, expires: null };

function fetchManifest(timeoutMs = 8000) {
  // Cache-bust on EVERY request. GitHub serves raw gist URLs through a CDN that ignores a
  // Cache-Control request header — verified: after flipping active:false, the plain raw URL kept
  // returning the stale active:true while ?t=<now> returned the new value. Without this the kill
  // switch silently does nothing: you revoke, and every client keeps reading the cached copy.
  const url = LICENSE_URL + (LICENSE_URL.includes('?') ? '&' : '?') + 't=' + Date.now();
  return new Promise((resolve) => {
    let req;
    try {
      req = https.get(url, { headers: { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' } }, (res) => {
        if (res.statusCode !== 200) { res.resume(); return resolve(null); }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { body += d; if (body.length > 1e6) req.destroy(); });
        res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
      });
    } catch { return resolve(null); }
    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs, () => { try { req.destroy(); } catch {} resolve(null); });
  });
}

// Ask the dashboard about a key. Returns {reached:true, ok, reason, expires, discord} on a JSON
// answer, or {reached:false} if the dashboard is down / errored (→ caller falls back to the gist).
function fetchDashboard(key, timeoutMs = 8000) {
  const url = `${DASHBOARD_URL}/api/license/verify?key=${encodeURIComponent(key)}`;
  return new Promise((resolve) => {
    let req;
    try {
      req = https.get(url, (res) => {
        if (res.statusCode !== 200) { res.resume(); return resolve({ reached: false }); }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { body += d; if (body.length > 1e5) req.destroy(); });
        res.on('end', () => { try { resolve({ reached: true, ...JSON.parse(body) }); } catch { resolve({ reached: false }); } });
      });
    } catch { return resolve({ reached: false }); }
    req.on('error', () => resolve({ reached: false }));
    req.setTimeout(timeoutMs, () => { try { req.destroy(); } catch {} resolve({ reached: false }); });
  });
}

function evaluate(manifest, key) {
  const k = String(key || '').trim().toLowerCase();     // DEATHWISH == deathwish
  if (!k) return { ok: false, reason: 'no key entered' };
  const entry = manifest && manifest.keys && manifest.keys[k];
  if (!entry) return { ok: false, reason: 'key not recognized' };
  if (entry.active === false) return { ok: false, reason: 'key deactivated' };
  if (entry.expires) {
    const t = Date.parse(entry.expires);
    if (!Number.isNaN(t) && Date.now() > t) return { ok: false, reason: `key expired (${entry.expires})` };
  }
  return { ok: true, reason: 'active', expires: entry.expires || null };
}

async function verifyLicense(key, { force = false } = {}) {
  if (!force && cache.at && Date.now() - cache.at < CHECK_TTL_MS) return cache;

  const k = String(key || '').trim();

  // 1) Dashboard first (new authority). A definitive answer wins; only an unrecognized key (or an
  //    unreachable dashboard) falls through to the legacy gist below.
  if (k) {
    const d = await fetchDashboard(k);
    if (d.reached && d.ok) {
      cache = { ok: true, reason: 'active', expires: d.expires || null, discord: d.discord || null, at: Date.now(), lastGood: Date.now() };
      return cache;
    }
    if (d.reached && d.reason === 'key deactivated') {
      cache = { ok: false, reason: 'key deactivated', at: Date.now(), lastGood: cache.lastGood };
      return cache;
    }
  }

  // 2) Legacy gist fallback. Retry once on a transient blip (fresh tester, no grace window yet).
  let manifest = await fetchManifest();
  if (!manifest) { await new Promise(r => setTimeout(r, 1200)); manifest = await fetchManifest(); }
  if (!manifest) {
    // Manifest unreachable. Honor a grace window after the last good check so a network blip
    // doesn't brick a live drop — but fail CLOSED after that, otherwise blocking the URL in a
    // hosts file would be a free bypass.
    const ok = !!cache.lastGood && (Date.now() - cache.lastGood < GRACE_MS);
    cache = { ...cache, ok, reason: ok ? 'offline — running on grace' : 'cannot reach license server', at: Date.now() };
    return cache;
  }
  const res = evaluate(manifest, key);
  cache = {
    ok: res.ok,
    reason: res.reason,
    expires: res.expires || null,
    at: Date.now(),
    lastGood: res.ok ? Date.now() : cache.lastGood,
  };
  return cache;
}

function cached() { return cache; }

// Force-fail the cached verdict without waiting for a re-verify. Used when the dashboard denies a
// RUNNING session (claimed elsewhere, HWID moved, key disabled): the app drops back to the key gate,
// and licensed() has to start refusing bot spawns the moment that happens rather than at the next
// TTL. lastGood is cleared too — leaving it set would let the offline grace window in verifyLicense
// wave the revoked key straight back through on the next network blip.
function invalidate(reason) {
  cache = { ok: false, reason: reason || 'revoked', at: Date.now(), lastGood: 0, expires: null };
}

module.exports = { verifyLicense, cached, invalidate, LICENSE_URL };
