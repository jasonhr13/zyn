import { config } from './config.js';

// Global token-bucket so aggregate request rate stays bounded regardless of how
// the loops schedule work. Not strictly concurrent-safe, but fine at our rates.
const capacity = config.pacing.maxRequestsPerMin;
const perMs = capacity / 60000;
let tokens = capacity;
let last = Date.now();

export async function pace() {
  const now = Date.now();
  tokens = Math.min(capacity, tokens + (now - last) * perMs);
  last = now;
  if (tokens >= 1) {
    tokens -= 1;
    return;
  }
  const waitMs = Math.ceil((1 - tokens) / perMs);
  await new Promise((r) => setTimeout(r, waitMs));
  tokens = 0;
  last = Date.now();
}
