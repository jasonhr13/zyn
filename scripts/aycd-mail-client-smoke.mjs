import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const modulePath = path.resolve('native-farmer/aycd-mail-client.mjs');
const { AYCD_POLL_INTERVAL_MS, fetchAuthCodeViaAycd } = await import(pathToFileURL(modulePath).href);
const originalFetch = globalThis.fetch;

assert.equal(AYCD_POLL_INTERVAL_MS, 1000);

try {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/tasks/mail/create')) {
      return { ok: true, status: 200, json: async () => ({ id: 'mail-task-1' }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ tasks: [{
        id: 'mail-task-1', status: 'success', results: { code: '654321' },
      }] }),
    };
  };
  const controller = new AbortController();
  const result = await fetchAuthCodeViaAycd({
    apiKey: 'test-key', targetEmail: 'person@example.com', fromFilter: 'target.com',
    timeoutMs: 1000, signal: controller.signal,
  });
  assert.equal(result.code, '654321');
  assert.equal(calls.length, 2);
  assert.equal(calls.every(call => call.options.signal === controller.signal), true);

  let completedStarted;
  const completed = new Promise(resolve => { completedStarted = resolve; });
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/tasks/mail/create')) {
      return { ok: true, status: 200, json: async () => ({ id: 'mail-task-2' }) };
    }
    completedStarted();
    return await new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('cancelled');
        error.name = 'AbortError';
        error.code = 'ABORT_ERR';
        reject(error);
      }, { once: true });
    });
  };
  const cancelledController = new AbortController();
  const cancelled = fetchAuthCodeViaAycd({
    apiKey: 'test-key', targetEmail: 'person@example.com', timeoutMs: 60000,
    signal: cancelledController.signal,
  });
  await completed;
  cancelledController.abort(new Error('IMAP won the provider race'));
  await assert.rejects(cancelled, error => error?.name === 'AbortError');
} finally {
  globalThis.fetch = originalFetch;
}

process.stdout.write('AYCD fast polling contract and losing-provider cancellation smoke test passed\n');
