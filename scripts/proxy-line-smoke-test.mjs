#!/usr/bin/env node

import assert from 'node:assert/strict';
import { parseProxyLine } from '../frontend/src/components/proxy-line.mjs';

assert.deepEqual(parseProxyLine('proxy.example:8000'), {
  server: 'proxy.example:8000', username: '', password: '',
});
assert.deepEqual(parseProxyLine('proxy.example:8000:user:pass:with:colons'), {
  server: 'proxy.example:8000', username: 'user', password: 'pass:with:colons',
});
assert.deepEqual(parseProxyLine('http://user:pass%3Aword@proxy.example:8080'), {
  server: 'http://proxy.example:8080', username: 'user', password: 'pass:word',
});
assert.deepEqual(parseProxyLine('[2001:db8::1]:9000:user:secret'), {
  server: '[2001:db8::1]:9000', username: 'user', password: 'secret',
});
assert.equal(parseProxyLine('proxy.example'), null);
assert.equal(parseProxyLine('proxy.example:not-a-port'), null);
assert.equal(parseProxyLine('ftp://proxy.example:21'), null);

console.log(JSON.stringify({ ok: true, formats: 4, invalidLinesRejected: true }, null, 2));
