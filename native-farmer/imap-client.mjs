// IMAP client to fetch authentication codes from emails.
//
// Polls the mailbox until a matching, code-bearing message arrives. Results are checked newest
// first and every message's real IMAP arrival time plus parsed From:/To: headers are verified before
// a code is accepted, so parallel or repeated logins cannot consume a stale code.
//
// Do not rely on server-side IMAP SEARCH for recent mail. Some providers advertise a recent-date
// search extension but return zero while the messages are visibly present in INBOX. Fetch the UIDs
// for only the newest bounded sequence range instead, then validate each message's exact IMAP
// arrival time and parsed From:/To: headers locally. This keeps new mail immediately visible without
// downloading or parsing the entire mailbox.

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

const POLL_INTERVAL_MS = 1000;
const SEARCH_WINDOW_MS = 10 * 60 * 1000;
const MAX_RECENT_CANDIDATES = 100;

// ImapFlow enters IDLE automatically whenever its command queue is empty. Wake the next scan as
// soon as the server announces a changed INBOX count, while retaining a short timer for providers
// that do not deliver reliable IDLE notifications.
export function waitForMailboxChange(client, timeoutMs) {
  return new Promise(resolve => {
    let timer;
    let settled = false;
    const finish = reason => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (typeof client?.removeListener === 'function') client.removeListener('exists', onExists);
      resolve(reason);
    };
    const onExists = () => finish('exists');
    if (typeof client?.once === 'function') client.once('exists', onExists);
    timer = setTimeout(() => finish('poll'), Math.max(0, Number(timeoutMs) || 0));
  });
}

export function isAbortError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

function abortError(signal) {
  const error = new Error('IMAP authentication-code request cancelled');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  if (signal?.reason instanceof Error) error.cause = signal.reason;
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

export function searchQuery(now = Date.now()) {
  return { since: new Date(now - SEARCH_WINDOW_MS) };
}

export async function recentCandidateUids(client, run = runDirectly, limit = MAX_RECENT_CANDIDATES) {
  // ImapFlow's sequence range is evaluated against the mailbox directly and does not depend on a
  // provider's date/header search index. Ask only for UID metadata here; message bodies are fetched
  // lazily below and cached between polls.
  if (typeof client?.fetchAll === 'function') {
    const mailboxSize = Math.max(0, Number(client?.mailbox?.exists) || 0);
    const boundedLimit = Math.max(1, Number(limit) || MAX_RECENT_CANDIDATES);
    const firstSequence = Math.max(1, mailboxSize - boundedLimit + 1);
    const entries = await run(() => client.fetchAll(`${firstSequence}:*`, { uid: true }));
    return (Array.isArray(entries) ? entries : [])
      .map(entry => Number(entry?.uid))
      .filter(uid => Number.isFinite(uid) && uid > 0);
  }

  // Test doubles and older compatible clients may not expose fetchAll. Keep the broad date search
  // as a compatibility fallback; production ImapFlow always takes the direct sequence path above.
  return await run(() => client.search(searchQuery(), { uid: true })) || [];
}

export function receivedAfterMatches(receivedAt, receivedAfter) {
  if (receivedAt == null || receivedAfter == null) return false;
  const receivedAtMs = receivedAt instanceof Date ? receivedAt.getTime() : new Date(receivedAt).getTime();
  const receivedAfterMs = receivedAfter instanceof Date ? receivedAfter.getTime() : Number(receivedAfter);
  return Number.isFinite(receivedAtMs) && Number.isFinite(receivedAfterMs) && receivedAtMs >= receivedAfterMs;
}

export function senderMatches(parsed, fromFilter) {
  const wanted = String(fromFilter || '').trim().toLowerCase();
  if (!wanted) return true;
  const actual = `${parsed?.from?.text || ''} ${parsed?.sender?.text || ''}`.toLowerCase();
  return actual.includes(wanted);
}

export function recipientMatches(parsed, targetEmail) {
  const wanted = String(targetEmail || '').trim().toLowerCase();
  if (!wanted) return true;
  return String(parsed?.to?.text || '').toLowerCase().includes(wanted);
}

export function extractCode(parsed, codePattern) {
  const flags = String(codePattern?.flags || '').replace(/[gy]/g, '');
  const pattern = codePattern instanceof RegExp
    ? new RegExp(codePattern.source, flags)
    : /(\d{6})/i;
  // Plain text is the most reliable representation. Subject is a useful fallback for Target, which
  // includes the code there, and HTML covers providers that omit a text part entirely.
  for (const source of [parsed?.text, parsed?.subject, parsed?.html]) {
    if (!source) continue;
    const match = String(source).match(pattern);
    if (match) return match[1] || match[0];
  }
  return '';
}

const runDirectly = operation => (typeof operation === 'function' ? operation() : operation);

async function parseMessage(client, uid, run = runDirectly) {
  const message = await run(() => client.fetchOne(uid, { source: true, internalDate: true }, { uid: true }));
  if (!message?.source) return null;
  const parsed = await simpleParser(message.source);
  return {
    parsed,
    // INTERNALDATE is assigned by the mailbox server and is not affected by a sender's Date header
    // or local clock. The parsed Date is only a defensive fallback for unusual IMAP servers.
    receivedAt: message.internalDate || parsed?.date || null,
  };
}

async function markSeen(client, uid, run = runDirectly) {
  // Mark only the message whose code is actually returned. The client-side scan now examines every
  // recent message, so marking during parsing would incorrectly read unrelated user mail.
  await run(() => client.messageFlagsAdd(uid, ['\\Seen'], { uid: true })).catch(() => {});
}

async function dumpInboxDiagnostic(client, log, run = runDirectly) {
  let uids;
  try {
    uids = await recentCandidateUids(client, run, MAX_RECENT_CANDIDATES);
  } catch (err) {
    log(`  [IMAP] Diagnostic scan failed: ${err.message}`);
    return;
  }

  if (!uids.length) {
    log('  [IMAP] Diagnostic: INBOX contains no message candidates. If you can see the email in Mail.app, this account/mailbox likely is not exposing that folder over IMAP.');
    return;
  }

  const newest = [...uids].sort((a, b) => b - a).slice(0, 10);
  const recent = [];
  const receivedAfter = Date.now() - SEARCH_WINDOW_MS;
  for (const uid of newest) {
    try {
      const message = await parseMessage(client, uid, run);
      if (!message || !receivedAfterMatches(message.receivedAt, receivedAfter)) continue;
      recent.push(message.parsed);
    } catch (err) {
      log(`  [IMAP] Diagnostic fetch failed for UID ${uid}: ${err.message}`);
    }
  }

  if (!recent.length) {
    log(`  [IMAP] Diagnostic: 0 message(s) actually arrived in INBOX in the last ${Math.round(SEARCH_WINDOW_MS / 60000)} min (the server's date-only search also returned older mail).`);
    return;
  }

  log(`  [IMAP] Diagnostic: ${recent.length} message(s) actually arrived in INBOX in the last ${Math.round(SEARCH_WINDOW_MS / 60000)} min — showing up to ${recent.length} newest:`);
  for (const parsed of recent) {
    log(`    From: ${parsed?.from?.text || ''} | To: ${parsed?.to?.text || ''} | Subject: ${parsed?.subject || ''} | Date: ${parsed?.date || ''}`);
  }
}

export async function fetchAuthCode(
  imapConfig,
  targetEmail,
  codePattern = /(\d{6})/i,
  timeoutMs = 60000,
  {
    onLog,
    fromFilter = 'p-bandai',
    relaxTo = false,
    signal,
    createClient,
    receivedAfter,
    pollIntervalMs = POLL_INTERVAL_MS,
  } = {},
) {
  const log = onLog || (() => {});
  throwIfAborted(signal);
  // A caller that knows when it requested this specific code supplies receivedAfter. Other flows
  // retain the intended ten-minute window, now enforced against the exact server arrival time
  // instead of trusting standard IMAP SINCE's day-level precision.
  const suppliedReceivedAfter = receivedAfter == null
    ? Number.NaN
    : (receivedAfter instanceof Date ? receivedAfter.getTime() : Number(receivedAfter));
  const minimumReceivedAt = Number.isFinite(suppliedReceivedAfter)
    ? suppliedReceivedAfter
    : Date.now() - SEARCH_WINDOW_MS;
  const pollDelayMs = Number.isFinite(Number(pollIntervalMs))
    ? Math.max(0, Number(pollIntervalMs))
    : POLL_INTERVAL_MS;
  const clientOptions = {
    host: imapConfig.host,
    port: imapConfig.port || 993,
    secure: true,
    auth: {
      user: imapConfig.user,
      pass: imapConfig.password,
    },
    tls: { rejectUnauthorized: false },
    logger: false,
  };
  const client = typeof createClient === 'function' ? createClient(clientOptions) : new ImapFlow(clientOptions);

  const deadline = Date.now() + timeoutMs;
  const messageByUid = new Map();
  const loggedStaleUids = new Set();
  let lock;

  // ImapFlow reports an established socket timeout through EventEmitter's special `error` event.
  // Without a listener Node treats it as an uncaught exception in Electron's main process, even
  // though this function itself is inside try/catch. Race that event into the active operation so
  // the caller receives a normal rejection and the task can report/retry it.
  let clientFailure = null;
  let rejectClientFailure;
  const clientFailurePromise = new Promise((_, reject) => { rejectClientFailure = reject; });
  clientFailurePromise.catch(() => {});
  const onClientError = (error) => {
    clientFailure = error instanceof Error ? error : new Error(String(error || 'IMAP connection error'));
    rejectClientFailure(clientFailure);
  };
  if (typeof client.on === 'function') client.on('error', onClientError);

  let rejectAbort;
  const abortPromise = new Promise((_, reject) => { rejectAbort = reject; });
  abortPromise.catch(() => {});
  let abortHandled = false;
  const onAbort = () => {
    if (abortHandled) return;
    abortHandled = true;
    rejectAbort(abortError(signal));
    // Closing the transport also releases any ImapFlow command currently awaiting a server reply.
    try { if (!client.isClosed && typeof client.close === 'function') client.close(); } catch {}
  };
  if (signal) {
    signal.addEventListener('abort', onAbort, { once: true });
    // Abort may have landed between the initial check and listener registration.
    if (signal.aborted) onAbort();
  }

  const run = (operation) => {
    throwIfAborted(signal);
    if (clientFailure) throw clientFailure;
    const activeOperation = typeof operation === 'function' ? operation() : operation;
    return Promise.race([Promise.resolve(activeOperation), clientFailurePromise, abortPromise]);
  };

  try {
    await run(() => client.connect());
    lock = await run(() => client.getMailboxLock('INBOX'));
    log(`  [IMAP] Connected as ${imapConfig.user} — INBOX has ${client.mailbox.exists} message(s) total.`);

    while (Date.now() <= deadline) {
      const matches = await recentCandidateUids(client, run, MAX_RECENT_CANDIDATES);
      if (!matches.length) {
        await run(() => waitForMailboxChange(client, Math.min(pollDelayMs, Math.max(0, deadline - Date.now()))));
        continue;
      }

      let fallback = null;
      const newest = [...matches].sort((a, b) => b - a).slice(0, MAX_RECENT_CANDIDATES);
      for (const uid of newest) {
        let message;
        try {
          if (messageByUid.has(uid)) message = messageByUid.get(uid);
          else {
            message = await parseMessage(client, uid, run);
            messageByUid.set(uid, message);
          }
        } catch {
          continue;
        }
        const parsed = message?.parsed;
        if (!parsed) continue;
        if (!senderMatches(parsed, fromFilter)) continue;
        if (!receivedAfterMatches(message.receivedAt, minimumReceivedAt)) {
          if (!loggedStaleUids.has(uid)) {
            loggedStaleUids.add(uid);
            const arrivedAtMs = new Date(message.receivedAt).getTime();
            const arrived = Number.isFinite(arrivedAtMs) ? new Date(arrivedAtMs).toISOString() : 'an unknown time';
            log(`  [IMAP] Ignoring stale ${fromFilter || 'matching'} code email received at ${arrived}; waiting for this login's email.`);
          }
          continue;
        }

        const matchedTo = parsed.to?.text || '';
        const code = extractCode(parsed, codePattern);
        if (!code) continue;

        if (!recipientMatches(parsed, targetEmail)) {
          if (relaxTo && !fallback) fallback = { code, matchedTo, uid };
          continue;
        }
        await markSeen(client, uid, run);
        return { code, matchedTo };
      }

      if (relaxTo && fallback) {
        log(`  [IMAP] No message addressed to ${targetEmail} — using newest ${fromFilter} code in the window (To: ${fallback.matchedTo || 'unknown'}).`);
        await markSeen(client, fallback.uid, run);
        return { code: fallback.code, matchedTo: fallback.matchedTo };
      }
      await run(() => waitForMailboxChange(client, Math.min(pollDelayMs, Math.max(0, deadline - Date.now()))));
    }

    await dumpInboxDiagnostic(client, log, run);
    throw new Error(`Auth code not found within ${timeoutMs}ms`);
  } finally {
    try { lock?.release(); } catch {}
    if (client.usable) await client.logout().catch(() => {});
    else if (!client.isClosed && typeof client.close === 'function') {
      try { client.close(); } catch {}
    }
    if (signal) signal.removeEventListener('abort', onAbort);
    // Keep the listener on this now-unreachable client. A transport may schedule one final error
    // after close() returns; retaining the no-throw handler until garbage collection prevents that
    // late event from becoming another Electron main-process uncaught exception.
  }
}
