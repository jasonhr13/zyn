// Client for the shared queue-pass pool (see queue-pass-server/api/queue-pass.js).
//
// The problem this solves: every user's app parses the SAME Discord messages into its own local
// pool, so each one independently decides "the newest link" and they all grab the same token. No
// amount of local dedup fixes that — an app cannot see what another user's app already took. The
// server holds one pool and hands each token out exactly once, across the whole userbase.
//
// Everything here is best-effort. If the server is slow, down, or not configured, callers fall back
// to the local pool and the drop proceeds exactly as it does today. A claim service outage must
// never be able to stop a checkout.

import Store, { claimLinks, freshPool } from './store';

const DASHBOARD_URL = 'https://secret-lair-dashboard.vercel.app';
const ENDPOINT = `${DASHBOARD_URL}/api/queue-pass`;

// Tight timeouts: this sits directly in the checkout path during a drop. Waiting 10s on an
// unresponsive server would cost more than the distribution is worth — bail and use the local pool.
const CLAIM_TIMEOUT_MS = 2500;
const PUSH_TIMEOUT_MS = 4000;

const licenseKey = () => ((Store.getState().settings || {}).licenseKey || '').trim();

async function post(payload, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json && json.ok ? json : null;
  } catch {
    return null;   // network error, timeout, abort — caller falls back
  } finally {
    clearTimeout(timer);
  }
}

// Contribute links this client saw in Discord. Fire-and-forget: the server dedupes on qitq, so
// every client reporting every link it sees is correct and needs no coordination.
export function pushLinks(links) {
  const key = licenseKey();
  if (!key || !links || !links.length) return;
  post({ action: 'push', key, links }, PUSH_TIMEOUT_MS);
}

// Claim up to `n` links for this machine. Server first (globally unique), local pool as fallback.
//
// Returns links already marked spent locally, so the two paths behave identically to the caller.
export async function claimLinksShared(n) {
  const want = Math.max(0, n | 0);
  if (!want) return [];

  const key = licenseKey();
  if (key) {
    const json = await post({ action: 'claim', key, count: want }, CLAIM_TIMEOUT_MS);
    const links = (json && json.links) || [];
    if (links.length) {
      // Mark them spent locally too. The server already guarantees no one else can get these, but
      // this keeps the local pool honest if the same token also arrived via Discord on this machine.
      Store.dispatch({ type: 'consumeLinks', qitqs: links.map((l) => l.qitq) });
      if (links.length >= want) return links;
      // Server had some but not enough — top up from whatever is pooled locally.
      return links.concat(claimLinks(want - links.length));
    }
  }
  return claimLinks(want);
}

// Pool depth for the UI: local count plus the shared pool when reachable.
export async function sharedPoolDepth() {
  const local = freshPool(Store.getState().cartUrlPool).length;
  const key = licenseKey();
  if (!key) return { local, shared: null };
  const json = await post({ action: 'stats', key }, CLAIM_TIMEOUT_MS);
  return { local, shared: json ? json.pool : null };
}
