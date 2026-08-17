#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  billingHint,
  estimateCost,
  formatGb,
  formatUsd,
  generateBlockedReason,
  stateLabel,
} from '../frontend/src/components/resifactory-format.mjs';

assert.equal(formatGb(null), '—');
assert.equal(formatGb(0), '0 GB');
assert.equal(formatGb(2.5), '2.5 GB');
assert.equal(formatUsd(3.2), '$3.20');
assert.equal(estimateCost(2, 3.25), 6.5);
assert.match(billingHint({ connected: true, billingReady: false, canBill: false }), /Billing enabled/);
assert.match(billingHint({ connected: true, billingReady: false, canBill: true }), /spend cap/);
assert.match(generateBlockedReason({ granted: true, comingSoon: false, gb: 0 }, {
  connected: true, canGenerate: true,
}), /no remaining data/);
assert.match(generateBlockedReason({ granted: false, comingSoon: false, gb: 4 }, {
  connected: true, canGenerate: true,
}), /Unlock/);
assert.equal(stateLabel('california'), 'California');
assert.equal(stateLabel('ca'), 'CA');

console.log('ResiFactory format helpers passed');
