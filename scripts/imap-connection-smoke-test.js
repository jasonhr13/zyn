#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const {
  friendlyConnectionError,
  normalizeConfig,
  testImapConnection,
  validateConfig,
} = require('../launcher/imap-connection');

async function main() {
  assert.deepEqual(normalizeConfig({
    host: ' imap.example.com ', port: '993', user: ' person@example.com ', password: 'ab\u200B cd\n',
  }), { host: 'imap.example.com', port: 993, user: 'person@example.com', password: 'ab cd ' });
  assert.match(validateConfig({ host: '', port: 993, user: '', password: '' }), /server/i);
  assert.match(friendlyConnectionError({ code: 'AUTHENTICATIONFAILED' }), /rejected/i);
  assert.match(friendlyConnectionError({ code: 'ETIMEDOUT' }), /timed out/i);

  let receivedOptions = null;
  let closed = false;
  const success = await testImapConnection({
    host: 'imap.example.com', port: 993, user: 'one@example.com', password: 'secret',
  }, {
    timeoutMs: 4321,
    createClient: options => {
      receivedOptions = options;
      return { isClosed: false, connect: async () => {}, close: () => { closed = true; } };
    },
  });
  assert.equal(success.ok, true);
  assert.equal(receivedOptions.verifyOnly, true);
  assert.equal(receivedOptions.secure, true);
  assert.equal(receivedOptions.connectionTimeout, 4321);
  assert.equal(closed, true);

  const failure = await testImapConnection({
    host: 'imap.example.com', port: 993, user: 'one@example.com', password: 'bad',
  }, {
    createClient: () => ({
      isClosed: false,
      connect: async () => { const error = new Error('Login failed'); error.code = 'AUTHENTICATIONFAILED'; throw error; },
      close: () => {},
    }),
  });
  assert.equal(failure.ok, false);
  assert.match(failure.message, /rejected/i);

  console.log(JSON.stringify({ ok: true, verifyOnly: true, friendlyErrors: true }, null, 2));
}

main().catch(error => { console.error(error); process.exit(1); });
