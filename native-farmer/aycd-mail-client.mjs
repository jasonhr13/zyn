// AYCD Inbox Mail Tasks API client. AYCD creates one server-side mail task, then exposes its
// result through a completed-task feed. This file is packaged over the runtime-base copy so Target
// can cancel a losing AYCD request when the profile IMAP inbox finds the same code first.

const BASE = 'https://inbox-api.aycd.io/api/v1';
export const AYCD_POLL_INTERVAL_MS = 1000;

function authHeaders(apiKey) {
  return { Authorization: `Token ${apiKey}` };
}

function abortError(signal) {
  const error = new Error('AYCD authentication-code request cancelled');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  if (signal?.reason instanceof Error) error.cause = signal.reason;
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);
    let timer;
    const done = () => {
      if (signal) signal.removeEventListener('abort', cancelled);
      clearTimeout(timer);
      resolve();
    };
    const cancelled = () => {
      if (signal) signal.removeEventListener('abort', cancelled);
      clearTimeout(timer);
      reject(abortError(signal));
    };
    timer = setTimeout(done, Math.max(0, Number(ms) || 0));
    if (signal) signal.addEventListener('abort', cancelled, { once: true });
  });
}

export async function verifyAycdApiKey(apiKey, { signal } = {}) {
  throwIfAborted(signal);
  const response = await fetch(`${BASE}/user/verify`, {
    method: 'GET', headers: authHeaders(apiKey), signal,
  });
  if (response.status === 401) {
    throw new Error('AYCD: invalid API key (or the Inbox desktop app is not running)');
  }
  if (!response.ok) throw new Error(`AYCD: verify failed (HTTP ${response.status})`);
}

async function createMailTask(apiKey, task, signal) {
  throwIfAborted(signal);
  const response = await fetch(`${BASE}/tasks/mail/create`, {
    method: 'POST',
    headers: { ...authHeaders(apiKey), 'Content-Type': 'application/json' },
    body: JSON.stringify(task),
    signal,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`AYCD: create task failed (HTTP ${response.status}): ${body.slice(0, 200)}`);
  }
  const data = await response.json();
  if (!data.id) throw new Error(`AYCD: create task response missing id: ${JSON.stringify(data).slice(0, 200)}`);
  return data.id;
}

async function pollForTask(apiKey, group, taskId, deadline, signal) {
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    const response = await fetch(`${BASE}/tasks/completed?group=${encodeURIComponent(group)}`, {
      method: 'GET', headers: authHeaders(apiKey), signal,
    });
    if (response.ok) {
      const data = await response.json();
      const match = (data.tasks || []).find(task => task.id === taskId);
      if (match) return match;
    }
    await delay(Math.min(AYCD_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())), signal);
  }
  return { id: taskId, status: 'timeout' };
}

export async function fetchAuthCodeViaAycd({
  apiKey,
  targetEmail,
  fromFilter = '',
  codePattern = /(\d{4,8})/,
  timeoutMs = 60000,
  templateId = '',
  signal,
}) {
  if (!apiKey) throw new Error('AYCD: apiKey is required');
  if (!targetEmail) throw new Error('AYCD: targetEmail is required');
  throwIfAborted(signal);

  const group = `${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
  const timeoutSec = Math.max(1, Math.ceil(timeoutMs / 1000));
  const task = {
    group,
    email: targetEmail,
    receivedAt: Math.floor(Date.now() / 1000) - 10,
    timeout: timeoutSec,
    mailFilters: fromFilter ? [{ target: 'from', comparator: 'includes', value: fromFilter }] : [],
    mailElements: [{ name: 'code', target: 'body', regex: codePattern.source, regexSource: 'pretty' }],
    ...(templateId ? { templateId } : {}),
  };

  const taskId = await createMailTask(apiKey, task, signal);
  const result = await pollForTask(apiKey, group, taskId, Date.now() + timeoutMs + 5000, signal);
  if (result.status === 'timeout') {
    throw new Error(`AYCD: mail task timed out after ${timeoutSec}s (no matching email found for ${targetEmail})`);
  }
  if (result.status !== 'success') {
    const results = result.results || {};
    const message = results.errorMessage || results.errorStatus || result.status;
    throw new Error(`AYCD: mail task failed: ${message}`);
  }
  const code = (result.results || {}).code;
  if (!code) throw new Error('AYCD: task succeeded without a code result');
  return { code: String(code).split('\n')[0], matchedTo: targetEmail };
}
