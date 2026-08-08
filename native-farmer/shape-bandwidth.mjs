// Proxy bandwidth helpers for the Shape farmer. Keep Shape's JS/fingerprint surface intact:
// only drop bulk binary assets that Shape does not need to mint headers.

// Hope's existing control promises images, video, and fonts. Keep the upstream image/media policy
// and retain the recovered farmer's font block so moving to native does not regress proxy savings.
export const HEAVY_RESOURCE_TYPES = Object.freeze(['image', 'media', 'font']);

/** True when Playwright should abort this request to save proxy GB. Never blocks scripts. */
export function shouldBlockHeavyResource(resourceType) {
  return HEAVY_RESOURCE_TYPES.includes(String(resourceType || '').toLowerCase());
}

/**
 * Install a page.route filter that aborts image/media/font requests only.
 * Returns an uninstall function (best-effort).
 */
export async function installHeavyResourceBlock(page, { enabled = true } = {}) {
  if (!enabled || !page || typeof page.route !== 'function') return async () => {};
  const handler = (route) => {
    try {
      const type = route.request().resourceType();
      if (shouldBlockHeavyResource(type)) return route.abort();
      return route.continue();
    } catch {
      try { return route.continue(); } catch { /* page closed */ }
    }
  };
  await page.route('**/*', handler);
  return async () => {
    try { await page.unroute('**/*', handler); } catch { /* ignore */ }
  };
}

export function blockHeavyResourcesEnabled(argValue) {
  // Default ON. Explicit false/0/off/no disables for yield debugging.
  const raw = String(argValue == null ? 'true' : argValue).trim().toLowerCase();
  if (raw === '' || raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on') return true;
  if (raw === 'false' || raw === '0' || raw === 'no' || raw === 'off') return false;
  return true;
}
