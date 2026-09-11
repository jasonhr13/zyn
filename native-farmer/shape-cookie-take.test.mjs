#!/usr/bin/env node
import assert from 'node:assert/strict';
import { isExtensionHarvestSource, takePreferredCookie } from './shape-cookie-take.mjs';

assert.equal(isExtensionHarvestSource('extension'), true);
assert.equal(isExtensionHarvestSource('Extension'), true);
assert.equal(isExtensionHarvestSource('inBot'), false);
assert.equal(isExtensionHarvestSource('inBotV2'), false);
assert.equal(isExtensionHarvestSource('mobile'), false);
assert.equal(isExtensionHarvestSource('patchright'), false);

const mixed = [
  { source: 'inBot', id: 'a' },
  { source: 'inBotV2', id: 'b' },
  { source: 'extension', id: 'c' },
  { source: 'extension', id: 'd' },
  { source: 'inBot', id: 'e' },
];
assert.equal(takePreferredCookie(mixed, 'atc').id, 'c');
assert.equal(takePreferredCookie(mixed, 'atc').id, 'd');
assert.equal(takePreferredCookie(mixed, 'atc').id, 'a');
assert.equal(takePreferredCookie(mixed, 'atc').id, 'b');
assert.equal(takePreferredCookie(mixed, 'atc').id, 'e');
assert.equal(takePreferredCookie(mixed, 'atc'), null);

const login = [
  { source: 'extension', id: 'ext' },
  { source: 'inBot', id: 'bot' },
];
assert.equal(takePreferredCookie(login, 'login').id, 'ext', 'login stays FIFO');
assert.equal(takePreferredCookie(login, 'login').id, 'bot');

const onlyBot = [{ source: 'inBot', id: 'x' }, { source: 'patchright', id: 'y' }];
assert.equal(takePreferredCookie(onlyBot, 'atc').id, 'x');
assert.equal(takePreferredCookie(onlyBot, 'atc').id, 'y');
assert.equal(takePreferredCookie([], 'atc'), null);
assert.equal(takePreferredCookie(null, 'atc'), null);

console.log('ATC cookie take prefers extension harvests, then FIFO');
