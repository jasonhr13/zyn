const MIN_RELAUNCH_DELAY_MS = 1_000;
const MAX_RELAUNCH_DELAY_MS = 3_000;

// Route quarantine owns the long backoff. The worker slot itself only waits long enough to avoid a
// synchronized relaunch burst, then starts a fresh browser session on the next available route.
export function shapeWorkerRelaunchDelayMs(random = Math.random) {
  const sample = Math.max(0, Math.min(1, Number(random()) || 0));
  return Math.round(MIN_RELAUNCH_DELAY_MS
    + ((MAX_RELAUNCH_DELAY_MS - MIN_RELAUNCH_DELAY_MS) * sample));
}
