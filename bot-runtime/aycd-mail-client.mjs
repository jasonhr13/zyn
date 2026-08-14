// AYCD "Inbox" Mail Tasks API client — ported from AYCD's own official JS reference client
// (gitlab.com/aycd-inc/inbox-api-clients/inbox-api-client-js, file `inbox.ts`, fetched and read in
// full before writing this file — not guessed). AYCD Inbox is a separate desktop app the user
// connects their own mailboxes to on their end (OAuth/IMAP setup lives entirely inside Inbox); this
// script never sees mailbox credentials, only the per-instance API key from Inbox's own Settings >
// Tasks (API) panel. Per AYCD's docs, the Inbox desktop app must be RUNNING for the API key to work
// at all — a 401 with no other explanation usually means Inbox isn't open, not a bad key.
//
// Endpoints/auth header/polling model below are CONFIRMED — copied directly from the reference
// client's httpDo / sendMailTask / receiveMailTask / fetchTasks methods:
//   POST https://inbox-api.aycd.io/api/v1/tasks/mail/create   (create one mail task -> {id})
//   GET  https://inbox-api.aycd.io/api/v1/tasks/completed?group=<group>  (poll, batched by group)
//   GET  https://inbox-api.aycd.io/api/v1/user/verify         (401 = bad key)
//   Auth header: `Authorization: Token <apiKey>` (NOT "Bearer")
//
// SIMPLIFICATION vs. the reference client: theirs is a long-lived singleton meant to batch MANY
// concurrent tasks behind one shared poll loop across an app's whole lifetime (hence its internal
// task Map + shared fetchingPromise + appGroup persistence machinery). Each of our bot runs is a
// single short-lived process making exactly ONE mail task, so there's nothing to batch — this
// ports the same create-then-poll-by-group HTTP contract but as a single straight-line async
// function instead of a stateful service object.

const BASE = 'https://inbox-api.aycd.io/api/v1';

function authHeaders(apiKey) {
  return { Authorization: `Token ${apiKey}` };
}

// CONFIRMED — ported from MailTaskServiceImpl.verifyUserApiKey. Not called automatically by
// fetchAuthCodeViaAycd (a failed create/poll already surfaces a bad key clearly enough); exposed
// for a caller that wants to validate the key before committing to a run.
export async function verifyAycdApiKey(apiKey) {
  const res = await fetch(`${BASE}/user/verify`, { method: 'GET', headers: authHeaders(apiKey) });
  if (res.status === 401) throw new Error('AYCD: invalid API key (or the Inbox desktop app isn\'t running — the API key only works while Inbox is open)');
  if (!res.ok) throw new Error(`AYCD: verify failed (HTTP ${res.status})`);
}

// CONFIRMED — ported from sendMailTask.
async function createMailTask(apiKey, task) {
  const res = await fetch(`${BASE}/tasks/mail/create`, {
    method: 'POST',
    headers: { ...authHeaders(apiKey), 'Content-Type': 'application/json' },
    body: JSON.stringify(task),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`AYCD: create task failed (HTTP ${res.status}): ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  if (!data.id) throw new Error(`AYCD: create task response missing id: ${JSON.stringify(data).slice(0, 200)}`);
  return data.id;
}

// CONFIRMED (logic) — ported from fetchTasks()'s poll loop, simplified to one task instead of the
// reference client's shared multi-task Map (see header comment on why: no batching needed here).
async function pollForTask(apiKey, group, taskId, deadline) {
  while (Date.now() < deadline) {
    const res = await fetch(`${BASE}/tasks/completed?group=${encodeURIComponent(group)}`, {
      method: 'GET', headers: authHeaders(apiKey),
    });
    if (res.ok) {
      const data = await res.json();
      const match = (data.tasks || []).find(t => t.id === taskId);
      if (match) return match;
    }
    await new Promise(r => setTimeout(r, 3000));
  }
  return { id: taskId, status: 'timeout' };
}

// Fetches a verification code via AYCD Inbox. Mirrors imap-client.mjs's fetchAuthCode() return
// shape ({code, matchedTo}) so call sites can switch providers without restructuring.
//
// fromFilter: a plain substring the sender address must include — AYCD's own server-side
// MailFilter (target:'from', comparator:'includes'), not re-verified locally. AYCD's `email` field
// IS their own equivalent of imap-client.mjs's To:-header re-check: per their docs, "This is always
// the email address in the To header, not the mail account that receives it" — the same
// catchall-safety property imap-client.mjs's own To: verification provides for raw IMAP.
//
// codePattern: a JS RegExp with ONE capture group (default matches a bare 4-8 digit code, the same
// default imap-client.mjs's fetchAuthCode uses). `.source` is passed straight through as AYCD's
// MailElement.regex — plain digit-class patterns like this are valid in any common regex flavor
// (AYCD's docs don't state which engine they run server-side), so no translation needed.
export async function fetchAuthCodeViaAycd({ apiKey, targetEmail, fromFilter = '', codePattern = /(\d{4,8})/, timeoutMs = 60000, templateId = '' }) {
  if (!apiKey) throw new Error('AYCD: apiKey is required');
  if (!targetEmail) throw new Error('AYCD: targetEmail is required');

  const group = `${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
  const timeoutSec = Math.max(1, Math.ceil(timeoutMs / 1000));
  // "subtract 5-10 seconds if you are taking the timestamp after clicking [submit]" per AYCD's own
  // docs on `receivedAt` (clock drift). Our callers invoke this AFTER the real submit already
  // happened, so "now minus a buffer" is the right anchor, same reasoning as imap-client.mjs's own
  // SEARCH_WINDOW_MS.
  const receivedAt = Math.floor(Date.now() / 1000) - 10;

  const task = {
    group,
    email: targetEmail,
    receivedAt,
    timeout: timeoutSec,
    mailFilters: fromFilter ? [{ target: 'from', comparator: 'includes', value: fromFilter }] : [],
    mailElements: [{ name: 'code', target: 'body', regex: codePattern.source, regexSource: 'pretty' }],
    ...(templateId ? { templateId } : {}),
  };

  const taskId = await createMailTask(apiKey, task);
  // A little slack past the task's own timeout so a slow final poll iteration doesn't race AYCD's
  // own server-side timeout classification.
  const result = await pollForTask(apiKey, group, taskId, Date.now() + timeoutMs + 5000);

  if (result.status === 'timeout') {
    throw new Error(`AYCD: mail task timed out after ${timeoutSec}s (no matching email found for ${targetEmail})`);
  }
  if (result.status !== 'success') {
    const results = result.results || {};
    const err = results.errorMessage || results.errorStatus || result.status;
    throw new Error(`AYCD: mail task failed: ${err}`);
  }
  const code = (result.results || {}).code;
  if (!code) {
    throw new Error(`AYCD: task succeeded but no "code" element in results: ${JSON.stringify(result.results)}`);
  }
  // MailElement docs: multiple matches come back newline-joined — take the first.
  return { code: String(code).split('\n')[0], matchedTo: targetEmail };
}
