import {
  billingHint,
  estimateCost,
  formatGb,
  formatUsd,
  generateBlockedReason,
  stateLabel,
} from './resifactory-format.mjs';

test('formats remaining bandwidth without inventing a zero', () => {
  expect(formatGb(null)).toBe('—');
  expect(formatGb(0)).toBe('0 GB');
  expect(formatGb(2.5)).toBe('2.5 GB');
  expect(formatUsd(3.2)).toBe('$3.20');
  expect(estimateCost(2, 3.25)).toBe(6.5);
});

test('explains why billing or generate is unavailable', () => {
  expect(billingHint({ connected: true, billingReady: false, canBill: false })).toMatch(/Billing enabled/);
  expect(billingHint({ connected: true, billingReady: false, canBill: true })).toMatch(/spend cap/);
  expect(generateBlockedReason({ granted: true, comingSoon: false, gb: 0 }, {
    connected: true, canGenerate: true,
  })).toMatch(/no remaining GB/);
  expect(generateBlockedReason({ granted: false, comingSoon: false, gb: 4 }, {
    connected: true, canGenerate: true,
  })).toMatch(/Unlock/);
  expect(stateLabel('california')).toBe('California');
  expect(stateLabel('ca')).toBe('CA');
});
