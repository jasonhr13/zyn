import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

let temporaryModuleDirectory = '';
let modulePath;
if (process.argv[2]) {
  modulePath = path.resolve(process.argv[2]);
} else {
  temporaryModuleDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'zyn-imap-client-smoke-'));
  const resourcesDirectory = path.join(temporaryModuleDirectory, 'Resources');
  const botDirectory = path.join(resourcesDirectory, 'bot');
  fs.mkdirSync(botDirectory, { recursive: true });
  modulePath = path.join(botDirectory, 'imap-client.mjs');
  fs.copyFileSync(path.resolve('native-farmer/imap-client.mjs'), modulePath);
  fs.symlinkSync(path.resolve('launcher/node_modules'), path.join(botDirectory, 'node_modules'));
  fs.symlinkSync(path.resolve('extracted/asar/node_modules'), path.join(resourcesDirectory, 'node_modules'));
}
const {
  extractCode,
  fetchAuthCode,
  isAbortError,
  recentCandidateUids,
  recipientMatches,
  receivedAfterMatches,
  searchQuery,
  senderMatches,
  waitForMailboxChange,
} = await import(pathToFileURL(modulePath).href);

const now = 1_800_000_000_000;
const query = searchQuery(now);
assert.deepEqual(Object.keys(query), ['since']);
assert.equal(query.since instanceof Date, true);
assert.equal(query.since.getTime(), now - (10 * 60 * 1000));
assert.equal(receivedAfterMatches(new Date(now), now - 1), true);
assert.equal(receivedAfterMatches(new Date(now - 2), now - 1), false);
assert.equal(receivedAfterMatches(null, now - 1), false);

const targetMessage = {
  from: { text: '"Target" <orders@oe1.target.com>' },
  to: { text: 'Person <account@example.com>' },
  subject: 'Enter code 222222 to sign in',
  text: 'Your sign-in code is 111111.',
  html: '<p>Your sign-in code is <b>333333</b>.</p>',
};
assert.equal(senderMatches(targetMessage, 'target'), true);
assert.equal(senderMatches(targetMessage, 'TARGET.COM'), true);
assert.equal(senderMatches(targetMessage, 'p-bandai'), false);
assert.equal(recipientMatches(targetMessage, 'account@example.com'), true);
assert.equal(recipientMatches(targetMessage, 'someone-else@example.com'), false);
assert.equal(extractCode(targetMessage, /(\d{6})/), '111111');

assert.equal(extractCode({ subject: 'Use 444444 to continue' }, /(\d{6})/), '444444');
assert.equal(extractCode({ html: '<strong>555555</strong>' }, /(\d{6})/), '555555');
assert.equal(extractCode({ text: 'No code here' }, /(\d{6})/), '');

// A global caller regex must still return capture group 1 rather than the whole match array.
assert.equal(extractCode({ text: 'Code: 666666' }, /Code:\s*(\d{6})/g), '666666');

class FakeImapClient extends EventEmitter {
  constructor(onSearch) {
    super();
    this.onSearch = onSearch;
    this.isClosed = false;
    this.usable = false;
    this.mailbox = { exists: 0 };
    this.closeCalls = 0;
    this.lockReleases = 0;
    this.messages = new Map();
    this.seenUids = [];
    this.searchCalls = 0;
  }

  async connect() { this.usable = true; }
  async getMailboxLock() {
    return { release: () => { this.lockReleases += 1; } };
  }
  search() {
    this.searchCalls += 1;
    return this.onSearch(this);
  }
  fetchOne(uid) { return this.messages.get(uid) || null; }
  async messageFlagsAdd(uid) { this.seenUids.push(uid); }
  close() {
    this.closeCalls += 1;
    this.isClosed = true;
    this.usable = false;
  }
  async logout() { this.close(); }
}

// Regression: the live provider returned zero from its advertised recent-date search even while
// fresh Target messages were present in INBOX. Production must enumerate a bounded newest-message
// sequence directly and never depend on that broken search result.
let directScanClient;
const directScanResult = await fetchAuthCode(
  { host: 'imap.example.com', user: 'mailbox@example.com', password: 'secret' },
  'account@example.com',
  /(\d{6})/,
  1000,
  {
    fromFilter: 'target',
    receivedAfter: Date.now() - 10000,
    pollIntervalMs: 1,
    createClient() {
      directScanClient = new FakeImapClient(() => []);
      directScanClient.mailbox.exists = 834;
      directScanClient.fetchAllCalls = [];
      directScanClient.fetchAll = async (range, fetchQuery) => {
        directScanClient.fetchAllCalls.push({ range, query: fetchQuery });
        return [{ uid: 9001 }];
      };
      directScanClient.messages.set(9001, {
        source: Buffer.from([
          'From: Target <orders@oe1.target.com>',
          'To: account@example.com',
          'Subject: Your code is 777777',
          '',
          'Use 777777 to sign in.',
        ].join('\r\n')),
        internalDate: new Date(),
      });
      return directScanClient;
    },
  },
);
assert.equal(directScanResult.code, '777777');
assert.equal(directScanClient.searchCalls, 0);
assert.deepEqual(directScanClient.fetchAllCalls, [{ range: '735:*', query: { uid: true } }]);
assert.deepEqual(directScanClient.seenUids, [9001]);

// Compatible clients without fetchAll retain the broad server-search fallback.
const fallbackClient = new FakeImapClient(() => [12]);
assert.deepEqual(await recentCandidateUids(fallbackClient), [12]);
assert.equal(fallbackClient.searchCalls, 1);

let timeoutClient;
await assert.rejects(
  fetchAuthCode(
    { host: 'imap.example.com', user: 'mailbox@example.com', password: 'secret' },
    'account@example.com',
    /(\d{6})/,
    60000,
    {
      createClient() {
        timeoutClient = new FakeImapClient((client) => {
          queueMicrotask(() => {
            client.usable = false;
            client.emit('error', Object.assign(new Error('Socket timeout'), { code: 'ETIMEOUT' }));
          });
          return new Promise(() => {});
        });
        return timeoutClient;
      },
    },
  ),
  /Socket timeout/,
);
assert.equal(timeoutClient.closeCalls, 1);
assert.equal(timeoutClient.lockReleases, 1);
assert.equal(timeoutClient.listenerCount('error'), 1);
assert.doesNotThrow(() => timeoutClient.emit('error', new Error('late transport error after close')));

const controller = new AbortController();
let abortedClient;
let signalSearchStarted;
const searchStarted = new Promise((resolve) => { signalSearchStarted = resolve; });
const abortingFetch = fetchAuthCode(
  { host: 'imap.example.com', user: 'mailbox@example.com', password: 'secret' },
  'account@example.com',
  /(\d{6})/,
  60000,
  {
    signal: controller.signal,
    createClient() {
      abortedClient = new FakeImapClient(() => {
        signalSearchStarted();
        return new Promise(() => {});
      });
      return abortedClient;
    },
  },
);
await searchStarted;
controller.abort(new Error('Target task stopped'));
await assert.rejects(abortingFetch, isAbortError);
assert.equal(abortedClient.closeCalls, 1);
assert.equal(abortedClient.lockReleases, 1);
assert.equal(abortedClient.listenerCount('error'), 1);

// Gmail's standard IMAP SINCE search has day-level precision. The first poll can therefore include
// an expired code from hours earlier. It must be ignored while polling continues until a newly
// delivered UID appears.
const requestedAt = Date.now();
let delayedClient;
const delayedResult = await fetchAuthCode(
  { host: 'imap.example.com', user: 'mailbox@example.com', password: 'secret' },
  'account@example.com',
  /(\d{6})/,
  1000,
  {
    fromFilter: 'target',
    receivedAfter: requestedAt - 10000,
    pollIntervalMs: 1,
    createClient() {
      delayedClient = new FakeImapClient(client => (client.searchCalls === 1 ? [10] : [10, 11]));
      delayedClient.messages.set(10, {
        source: Buffer.from([
          'From: Target <orders@oe1.target.com>',
          'To: account@example.com',
          'Subject: Your code is 111111',
          '',
          'Use 111111 to sign in.',
        ].join('\r\n')),
        internalDate: new Date(requestedAt - (6 * 60 * 60 * 1000)),
      });
      delayedClient.messages.set(11, {
        source: Buffer.from([
          'From: Target <orders@oe1.target.com>',
          'To: account@example.com',
          'Subject: Your code is 222222',
          '',
          'Use 222222 to sign in.',
        ].join('\r\n')),
        internalDate: new Date(requestedAt),
      });
      return delayedClient;
    },
  },
);
assert.equal(delayedResult.code, '222222');
assert.equal(delayedClient.searchCalls >= 2, true);
assert.deepEqual(delayedClient.seenUids, [11]);

// A real ImapFlow connection enters IDLE between scans. A new-message EXISTS notification should
// interrupt the polling fallback so a code already arriving in INBOX is read immediately.
const idleClient = new FakeImapClient(() => []);
const idleStartedAt = Date.now();
const idleWait = waitForMailboxChange(idleClient, 500);
setTimeout(() => idleClient.emit('exists', { path: 'INBOX', count: 1, prevCount: 0 }), 15);
assert.equal(await idleWait, 'exists');
assert.equal(Date.now() - idleStartedAt < 300, true);
assert.equal(idleClient.listenerCount('exists'), 0);

process.stdout.write('IMAP freshness, IDLE wakeup, delayed delivery, filtering, socket-error handling, and cancellation smoke test passed\n');
if (temporaryModuleDirectory) fs.rmSync(temporaryModuleDirectory, { recursive: true, force: true });
