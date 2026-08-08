// Bounds for the operator-facing farmer throughput controls. Keeping these finite prevents a typo
// in settings.json from making one page loop forever or pinning one proxy to a browser indefinitely.
export const MAX_CAPTURES_PER_LOAD = 10;
export const MAX_LOADS_PER_BROWSER = 10;

const boundedInteger = (value, fallback, maximum) => {
  const parsed = Number.parseInt(String(value == null ? '' : value), 10);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(maximum, parsed)) : fallback;
};

export function shapeFarmerThroughputOptions({ capturesPerLoad, loadsPerBrowser } = {}) {
  return {
    // Target currently tends to emit one usable signature from a page. Multi-capture remains opt-in
    // so operators can raise it when live behavior proves the page will generate more than one.
    capturesPerLoad: boundedInteger(capturesPerLoad, 1, MAX_CAPTURES_PER_LOAD),
    // Reusing a process is proven useful, so amortise launches across one to three fresh contexts.
    loadsPerBrowser: boundedInteger(loadsPerBrowser, 3, MAX_LOADS_PER_BROWSER),
  };
}

// Randomise every browser session between one and its configured ceiling. This prevents all worker
// slots from recycling together and keeps a browser/proxy pairing from becoming a fixed cadence.
export function randomLoadsForBrowser(loadsPerBrowser, random = Math.random) {
  const maximum = boundedInteger(loadsPerBrowser, 3, MAX_LOADS_PER_BROWSER);
  const sample = Math.max(0, Math.min(0.999999999999, Number(random()) || 0));
  return 1 + Math.floor(sample * maximum);
}
