#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  appReleaseNotesPath,
  normalizedOrigin,
  publishAppReleaseNotification,
  readAppReleaseNotes,
  readUploadCredential,
  validateAppReleaseNotes,
} = require('./zyn-app-release-notification-lib.cjs');

const version = '1.6.93';
const notes = {
  schemaVersion: 1,
  version,
  notes: [
    'Connect multiple browser harvesters at the same time.',
    'Track every browser harvester independently in the shared bank.',
    'Run browser-extension and in-app harvesters together.',
  ],
};

function jsonResponse(value, status) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function expectSafeFailure(status, body, expected) {
  const secret = 'fixture-secret-that-must-not-leak';
  await assert.rejects(
    publishAppReleaseNotification({
      fetchImpl: async () => jsonResponse(body, status),
      token: secret,
      releaseNotes: notes,
      uploadOrigin: 'https://upload.example',
    }),
    error => {
      assert.match(error.message, expected);
      assert.doesNotMatch(error.message, new RegExp(secret));
      assert.doesNotMatch(error.message, /malicious server detail/);
      return true;
    },
  );
}

async function run() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'zyn-app-notification-smoke-'));
  try {
    assert.deepEqual(validateAppReleaseNotes({ ...notes }, version), notes);
    assert.throws(
      () => validateAppReleaseNotes({ ...notes, unexpected: true }),
      /must contain exactly/,
    );
    assert.throws(
      () => validateAppReleaseNotes({ ...notes, schemaVersion: 2 }),
      /schema must be 1/,
    );
    assert.throws(
      () => validateAppReleaseNotes({ ...notes, version: '01.6.93' }),
      /three-part semantic version/,
    );
    assert.throws(
      () => validateAppReleaseNotes({ ...notes, notes: notes.notes.slice(0, 2) }),
      /3-6 entries/,
    );
    assert.throws(
      () => validateAppReleaseNotes({ ...notes, notes: [...notes.notes, ...notes.notes, 'Extra'] }),
      /3-6 entries/,
    );
    assert.throws(
      () => validateAppReleaseNotes({ ...notes, notes: [notes.notes[0], notes.notes[1], '@everyone update'] }),
      /mention or code syntax/,
    );
    assert.throws(
      () => validateAppReleaseNotes({ ...notes, notes: [notes.notes[0], notes.notes[1], 'line one\nline two'] }),
      /single line/,
    );
    assert.throws(
      () => validateAppReleaseNotes({ ...notes, notes: [notes.notes[0], notes.notes[0], notes.notes[2]] }),
      /duplicate/,
    );
    assert.throws(
      () => validateAppReleaseNotes({ ...notes, notes: [notes.notes[0], notes.notes[1], 'x'.repeat(121)] }),
      /10-120 characters/,
    );
    assert.throws(
      () => validateAppReleaseNotes({ ...notes, notes: [notes.notes[0], notes.notes[1], 'Too short'] }),
      /10-120 characters/,
    );
    assert.throws(
      () => validateAppReleaseNotes({ ...notes, notes: [
        notes.notes[0], notes.notes[0].toLocaleUpperCase('en-US'), notes.notes[2],
      ] }),
      /duplicate/,
    );

    const projectRoot = path.join(temporary, 'project');
    const notesFile = appReleaseNotesPath(projectRoot, version);
    fs.mkdirSync(path.dirname(notesFile), { recursive: true });
    fs.writeFileSync(notesFile, `${JSON.stringify(notes, null, 2)}\n`);
    assert.deepEqual(readAppReleaseNotes(notesFile, version), notes);
    assert.throws(() => readAppReleaseNotes(notesFile, '1.6.94'), /but this release is 1.6.94/);

    assert.equal(normalizedOrigin('https://upload.example'), 'https://upload.example');
    assert.equal(normalizedOrigin('http://localhost:8787'), 'http://localhost:8787');
    for (const invalid of [
      '',
      'ftp://upload.example',
      'https://user:pass@upload.example',
      'https://upload.example/path',
      'https://upload.example/?token=secret',
    ]) {
      assert.throws(() => normalizedOrigin(invalid), /HTTP\(S\) origin/);
    }

    let credentialInvocation;
    const credential = readUploadCredential({
      execFileSyncImpl(command, args, options) {
        credentialInvocation = { command, args, options };
        return 'fixture-token\n';
      },
      account: 'fixture-account',
      service: 'fixture-service',
    });
    assert.equal(credential, 'fixture-token');
    assert.deepEqual(credentialInvocation, {
      command: 'security',
      args: [
        'find-generic-password', '-a', 'fixture-account', '-s', 'fixture-service', '-w',
      ],
      options: { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    });
    assert.throws(
      () => readUploadCredential({ execFileSyncImpl() { throw new Error('secret output'); } }),
      /missing from Keychain/,
    );
    assert.throws(
      () => readUploadCredential({ execFileSyncImpl() { return ' \n'; } }),
      /in Keychain is empty/,
    );

    const requests = [];
    const pending = await publishAppReleaseNotification({
      fetchImpl: async (input, options) => {
        requests.push({ input: String(input), options });
        return jsonResponse({
          published: false,
          ready: false,
          pending: true,
          notified: false,
          version,
          missing: ['windows'],
        }, 202);
      },
      token: 'fixture-token',
      releaseNotes: notes,
      uploadOrigin: 'https://upload.example',
    });
    assert.deepEqual(pending, { pending: true, notified: false, version });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].input, 'https://upload.example/__publish/app');
    assert.equal(requests[0].options.method, 'POST');
    assert.equal(requests[0].options.redirect, 'error');
    assert.equal(requests[0].options.headers.authorization, 'Bearer fixture-token');
    assert.deepEqual(JSON.parse(requests[0].options.body), notes);

    const success = await publishAppReleaseNotification({
      fetchImpl: async () => jsonResponse({
        published: true,
        ready: true,
        pending: false,
        notified: true,
        duplicate: false,
        version,
        messageId: '123456789012345678',
      }, 200),
      token: 'fixture-token',
      releaseNotes: notes,
      uploadOrigin: 'https://upload.example',
    });
    assert.deepEqual(success, {
      pending: false,
      notified: true,
      duplicate: false,
      version,
      messageId: '123456789012345678',
    });

    const duplicate = await publishAppReleaseNotification({
      fetchImpl: async () => jsonResponse({
        published: true,
        ready: true,
        pending: false,
        notified: true,
        duplicate: true,
        version,
        messageId: '123456789012345678',
      }, 200),
      token: 'fixture-token',
      releaseNotes: notes,
      uploadOrigin: 'https://upload.example',
    });
    assert.equal(duplicate.duplicate, true);

    await expectSafeFailure(409, { error: 'malicious server detail' }, /different app-release notification receipt/);
    await expectSafeFailure(502, { error: 'malicious server detail' }, /Discord notification failed/);
    await expectSafeFailure(401, { error: 'malicious server detail' }, /failed \(401\)/);
    await assert.rejects(
      publishAppReleaseNotification({
        fetchImpl: async () => { throw new Error('fixture-token malicious network detail'); },
        token: 'fixture-token',
        releaseNotes: notes,
        uploadOrigin: 'https://upload.example',
      }),
      error => {
        assert.match(error.message, /could not reach the updates service/);
        assert.doesNotMatch(error.message, /fixture-token|malicious/);
        return true;
      },
    );
    await assert.rejects(
      publishAppReleaseNotification({
        fetchImpl: async () => new Response('malicious server detail', { status: 200 }),
        token: 'fixture-token',
        releaseNotes: notes,
        uploadOrigin: 'https://upload.example',
      }),
      error => {
        assert.match(error.message, /invalid response/);
        assert.doesNotMatch(error.message, /malicious/);
        return true;
      },
    );
    await assert.rejects(
      publishAppReleaseNotification({
        fetchImpl: async () => jsonResponse({ notified: true, version }, 202),
        token: 'fixture-token',
        releaseNotes: notes,
        uploadOrigin: 'https://upload.example',
      }),
      /invalid pending response/,
    );
    await assert.rejects(
      publishAppReleaseNotification({
        fetchImpl: async () => jsonResponse({ notified: true, duplicate: false, version, messageId: 'not-a-number' }, 200),
        token: 'fixture-token',
        releaseNotes: notes,
        uploadOrigin: 'https://upload.example',
      }),
      /did not confirm/,
    );

    console.log(JSON.stringify({
      ok: true,
      version,
      notes: notes.notes.length,
      mockedRequests: requests.length,
    }, null, 2));
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
