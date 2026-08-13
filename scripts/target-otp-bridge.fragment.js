// Engine emits `request-code {email}` and blocks in WaitForCode until we send `received-code`.
// Fetch the login code from AYCD and profile IMAP in parallel, then use the first verified result.
// email -> { controller }. Owning the cancellation handle here lets task/group Stop close the
// mailbox transport instead of merely hiding the OTP prompt while a four-minute poll survives in
// the background and later emits an uncaught socket timeout.
const otpFetches = new Map();

// Codes the engine is currently waiting on: lowercased email ->
// { email, taskId, since, phase, message }.
// Surfaced to the UI so a code can be typed in by hand when the mailbox is slow, unreachable, or
// simply not configured — the engine blocks in WaitForCode either way, so without this a task just
// sits there until it times out.
const otpPending = new Map();

function emitOtpPending() {
  toRenderer('targetOtp', {
    pending: [...otpPending.values()].map(p => ({
      email: p.email, taskId: p.taskId, since: p.since,
      waiting: p.waiters ? p.waiters.size : 1,
      phase: p.phase || 'starting',
      message: p.message || 'Preparing automatic email lookup…',
    })),
  });
}

function updateOtpPending(key, patch) {
  const entry = otpPending.get(String(key || '').toLowerCase());
  if (!entry) return false;
  Object.assign(entry, patch || {});
  emitOtpPending();
  return true;
}

function abortOtpFetch(key, reason = 'OTP request cancelled') {
  const normalized = String(key || '').toLowerCase();
  const active = otpFetches.get(normalized);
  if (!active) return false;
  // Delete before aborting so an old fetch's finally block cannot remove a newer fetch for the same
  // address if the user restarts quickly.
  otpFetches.delete(normalized);
  try { active.controller.abort(new Error(reason)); } catch {}
  return true;
}

function cancelOtpForTask(taskId, reason = 'Target task stopped') {
  const wanted = String(taskId || '');
  if (!wanted) return false;
  let changed = false;
  for (const [key, entry] of otpPending) {
    if (!entry?.waiters?.has(wanted) && String(entry?.taskId || '') !== wanted) continue;
    if (entry.waiters) entry.waiters.delete(wanted);
    changed = true;
    if (!entry.waiters || entry.waiters.size === 0) {
      otpPending.delete(key);
      abortOtpFetch(key, reason);
    } else if (String(entry.taskId || '') === wanted) {
      entry.taskId = [...entry.waiters][0] || '';
    }
  }
  if (changed) emitOtpPending();
  return changed;
}

function cancelAllOtpFetches(reason = 'Target run stopped') {
  for (const key of [...otpFetches.keys()]) abortOtpFetch(key, reason);
  otpPending.clear();
  emitOtpPending();
}

// Hand a code to the engine and clear the prompt. Shared by the automatic (IMAP/AYCD) path and the
// manual one, so both retire the pending entry identically. Never put the code itself in a log.
function deliverOtp(addr, code, source, fetchState = null) {
  const key = String(addr).toLowerCase();
  if (fetchState && (otpFetches.get(key) !== fetchState || fetchState.controller.signal.aborted || !otpPending.has(key))) {
    vlog(`[otp] stale code for ${addr} ignored after its task stopped or restarted`);
    return false;
  }
  const entry = otpPending.get(key);
  log(`[otp] code found ${source} — submitting it`, (entry && entry.taskId) || '');
  if (entry) {
    entry.phase = 'submitting';
    entry.message = source === 'entered by hand'
      ? 'Manual code received — submitting to Target…'
      : 'Email code found — submitting to Target…';
    emitOtpPending();
  }
  sendToEngine({ type: 'received-code', messages: [{ email: addr, code: String(code), site: 'Target' }] });
  // One code satisfies one login. Keep the prompt and waiter state for any sibling task using the
  // same account; each Target login sends its own message.
  if (entry && entry.waiters && entry.waiters.size > 1) {
    const [first] = entry.waiters;
    entry.waiters.delete(first);
    entry.taskId = [...entry.waiters][0] || entry.taskId;
    entry.since = Date.now();
    entry.phase = 'starting';
    entry.message = 'Preparing the next automatic email lookup…';
    log(`[otp] ${entry.waiters.size} more task(s) still waiting on this mailbox`, entry.taskId || '');
    // The current lookup owns the code it just returned. Start a fresh provider race for the next
    // waiter after this call's finally block retires the current fetch; otherwise sibling tasks on
    // the same account can remain visible in the UI with no mailbox lookup behind them.
    setTimeout(() => {
      const next = otpPending.get(key);
      if (next && !otpFetches.has(key)) fetchOtpAndDeliver(next.email, next.taskId);
    }, 0);
  } else {
    otpPending.delete(key);
    // Leave the successful hand-off visible long enough to be perceived. This only delays the
    // renderer clear; the code has already reached the engine and the pending map is already clean.
    setTimeout(emitOtpPending, 900);
  }
  if (otpPending.has(key)) emitOtpPending();
  return true;
}

function submitOtpManually(email, code) {
  const addr = String(email || '').trim();
  const c = String(code || '').trim();
  if (!addr || !c) return false;
  deliverOtp(addr, c, 'entered by hand');
  abortOtpFetch(addr, 'Manual OTP supplied');
  return true;
}

async function fetchOtpAndDeliver(email, taskId = '') {
  const addr = String(email || '').trim();
  if (!addr) return;
  // Both providers use the same request-time freshness anchor, with a small clock/delivery buffer.
  const receivedAfter = Date.now() - 10000;
  const key = addr.toLowerCase();
  if (otpFetches.has(key)) {
    const open = otpPending.get(key);
    if (open) {
      if (!open.waiters) open.waiters = new Set([open.taskId || 'anon-0']);
      open.waiters.add(taskId || `anon-${open.waiters.size}`);
      emitOtpPending();
    }
    log('[otp] this account already has a mailbox fetch running — this task will take the next code', taskId);
    return;
  }
  const fetchState = { controller: new AbortController() };
  otpFetches.set(key, fetchState);
  const open = otpPending.get(key);
  const waiters = (open && open.waiters) || new Set();
  waiters.add(taskId || `anon-${waiters.size}`);
  otpPending.set(key, {
    email: addr,
    taskId,
    since: Date.now(),
    waiters,
    phase: 'starting',
    message: 'Preparing automatic email lookup…',
  });
  emitOtpPending();
  const botDir = botDirPath();
  let sourceController = null;
  let forwardAbort = null;
  try {
    const aycdKey = getAycdKey();
    const profileId = taskProfileById.get(taskId) || '';
    const c = getImapConfig(profileId, addr);
    sourceController = new AbortController();
    forwardAbort = () => {
      if (!sourceController.signal.aborted) {
        sourceController.abort(fetchState.controller.signal.reason || new Error('OTP request cancelled'));
      }
    };
    fetchState.controller.signal.addEventListener('abort', forwardAbort, { once: true });
    if (fetchState.controller.signal.aborted) forwardAbort();

    // Register shared-mailbox ownership before either provider yields. Parallel task requests can
    // then require exact To: matching instead of letting the first connection consume a sibling's
    // code through relaxed catch-all matching.
    const hasImap = Boolean(c.host && c.user && c.password);
    const mailboxKey = hasImap
      ? `${String(c.host).toLowerCase()}|${String(c.user).toLowerCase()}`
      : '';
    const currentPending = otpPending.get(key);
    if (currentPending && mailboxKey) currentPending.mailboxKey = mailboxKey;

    const sources = [];
    let pollingAycd = false;
    let pollingImap = false;
    if (aycdKey) {
      if (typeof globalThis.fetch !== 'function') {
        try { const u = require('undici'); globalThis.fetch = u.fetch; globalThis.Headers = u.Headers; globalThis.Request = u.Request; globalThis.Response = u.Response; }
        catch { try { globalThis.fetch = require('node-fetch'); } catch {} }
      }
      const script = path.join(botDir, 'aycd-mail-client.mjs');
      if (fs.existsSync(script)) {
        pollingAycd = true;
        log('[otp] checking AYCD Inbox for the Target email', taskId);
        sources.push((async () => {
          try {
            const { fetchAuthCodeViaAycd } = await import(pathToFileURL(script).href);
            const found = await fetchAuthCodeViaAycd({
              apiKey: aycdKey, targetEmail: addr, fromFilter: 'target.com',
              codePattern: /(\d{4,8})/, timeoutMs: 120000, signal: sourceController.signal,
            });
            if (!found?.code) throw new Error('AYCD returned no code');
            return { code: found.code, source: 'from AYCD Inbox' };
          } catch (error) {
            if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') throw error;
            log('[otp] AYCD failed: ' + ((error && error.message) || error)
              + (hasImap ? ' — profile IMAP is still checking' : ''), taskId);
            throw error;
          }
        })());
      } else {
        log('[otp] AYCD mailbox reader is missing from this Zyn installation', taskId);
      }
    }

    if (hasImap) {
      const script = path.join(botDir, 'imap-client.mjs');
      if (fs.existsSync(script)) {
        pollingImap = true;
        log('[otp] checking the selected profile mailbox for the Target code', taskId);
        sources.push((async () => {
          try {
            const { fetchAuthCode } = await import(pathToFileURL(script).href);
            // Let other request-code messages from the same engine frame register their mailbox
            // keys before deciding whether relaxed recipient matching is safe.
            await new Promise(resolve => setTimeout(resolve, 0));
            const mailboxWaiters = [...otpPending.values()].filter(p => p.mailboxKey === mailboxKey).length;
            const soloLogin = mailboxWaiters <= 1;
            if (!soloLogin) {
              log(`[otp] ${mailboxWaiters} logins share this mailbox — matching each code to its exact recipient`, taskId);
            }
            const result = await fetchAuthCode(
              { host: c.host, port: c.port, user: c.user, password: c.password },
              addr,
              /(\d{6})/,
              240000,
              {
                fromFilter: 'target', relaxTo: soloLogin, signal: sourceController.signal, receivedAfter,
                onLog: (line) => log(String(line), taskId),
              },
            );
            if (!result?.code) throw new Error('No new Target code was found in this mailbox');
            return { code: result.code, source: 'from profile mailbox' };
          } catch (error) {
            if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') throw error;
            log('[otp] profile mailbox failed: ' + ((error && error.message) || error), taskId);
            throw error;
          }
        })());
      } else {
        log('[otp] mailbox reader is missing from this Zyn installation', taskId);
      }
    }

    if (!sources.length) {
      updateOtpPending(key, {
        phase: 'manual',
        message: 'Automatic email lookup is unavailable — enter the code manually.',
      });
      log('[otp] no OTP source configured — add an IMAP mailbox to the matching profile, or enter the code manually', taskId);
      return;
    }

    updateOtpPending(key, {
      phase: 'polling',
      message: pollingImap && pollingAycd
        ? 'Polling AYCD Inbox and the profile IMAP mailbox for the code…'
        : pollingImap
          ? 'Polling the profile IMAP mailbox for the code…'
          : 'Polling AYCD Inbox for the code…',
    });

    // AYCD and the profile inbox start together. The first verified code wins; aborting the shared
    // source controller immediately closes the losing IMAP socket or AYCD HTTP poll.
    const found = await Promise.any(sources);
    if (deliverOtp(addr, found.code, found.source, fetchState)) {
      sourceController.abort(new Error('OTP found by another source'));
    }
  } catch (e) {
    if (fetchState.controller.signal.aborted || e?.name === 'AbortError' || e?.code === 'ABORT_ERR') {
      vlog('[otp] mailbox fetch cancelled', taskId);
    } else {
      updateOtpPending(key, {
        phase: 'manual',
        message: 'Automatic email lookup finished without a code — enter it manually.',
      });
      log('[otp] every configured mailbox source finished without a code — enter it manually', taskId);
    }
  } finally {
    if (forwardAbort) fetchState.controller.signal.removeEventListener('abort', forwardAbort);
    if (sourceController && !sourceController.signal.aborted) {
      sourceController.abort(new Error('OTP lookup finished'));
    }
    if (otpFetches.get(key) === fetchState) otpFetches.delete(key);
  }
}
