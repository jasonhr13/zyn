// Engine emits `request-code {email}` and blocks in WaitForCode until we send `received-code`.
// Fetch the login code — AYCD first (if configured), then IMAP — same order as the register bots.
// email -> { controller }. Owning the cancellation handle here lets task/group Stop close the
// mailbox transport instead of merely hiding the OTP prompt while a four-minute poll survives in
// the background and later emits an uncaught socket timeout.
const otpFetches = new Map();

// Codes the engine is currently waiting on: lowercased email -> { email, taskId, since }.
// Surfaced to the UI so a code can be typed in by hand when the mailbox is slow, unreachable, or
// simply not configured — the engine blocks in WaitForCode either way, so without this a task just
// sits there until it times out.
const otpPending = new Map();

function emitOtpPending() {
  toRenderer('targetOtp', {
    pending: [...otpPending.values()].map(p => ({
      email: p.email, taskId: p.taskId, since: p.since,
      waiting: p.waiters ? p.waiters.size : 1,
    })),
  });
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
  sendToEngine({ type: 'received-code', messages: [{ email: addr, code: String(code), site: 'Target' }] });
  // One code satisfies one login. Keep the prompt and waiter state for any sibling task using the
  // same account; each Target login sends its own message.
  if (entry && entry.waiters && entry.waiters.size > 1) {
    const [first] = entry.waiters;
    entry.waiters.delete(first);
    entry.taskId = [...entry.waiters][0] || entry.taskId;
    entry.since = Date.now();
    log(`[otp] ${entry.waiters.size} more task(s) still waiting on this mailbox`, entry.taskId || '');
  } else {
    otpPending.delete(key);
  }
  emitOtpPending();
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
  // Anchor freshness before trying AYCD. If AYCD times out and IMAP becomes the fallback, the email
  // may already be a couple of minutes old but still belongs to this exact login request.
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
  otpPending.set(key, { email: addr, taskId, since: Date.now(), waiters });
  emitOtpPending();
  const botDir = botDirPath();
  const deliver = (code) => deliverOtp(addr, code, 'from mailbox', fetchState);
  try {
    const aycdKey = getAycdKey();
    const profileId = taskProfileById.get(taskId) || '';
    const c = getImapConfig(profileId, addr);
    if (aycdKey) {
      try {
        if (typeof globalThis.fetch !== 'function') {
          try { const u = require('undici'); globalThis.fetch = u.fetch; globalThis.Headers = u.Headers; globalThis.Request = u.Request; globalThis.Response = u.Response; }
          catch { try { globalThis.fetch = require('node-fetch'); } catch {} }
        }
        const script = path.join(botDir, 'aycd-mail-client.mjs');
        if (fs.existsSync(script)) {
          log('[otp] checking AYCD Inbox for the Target email', taskId);
          const { fetchAuthCodeViaAycd } = await import(pathToFileURL(script).href);
          const found = await fetchAuthCodeViaAycd({
            apiKey: aycdKey, targetEmail: addr, fromFilter: 'target.com',
            codePattern: /(\d{4,8})/, timeoutMs: 120000, signal: fetchState.controller.signal,
          });
          if (found && found.code) { deliver(found.code); return; }
          log('[otp] AYCD returned no code' + (c.host ? ' — trying this profile’s IMAP' : ''), taskId);
        }
      } catch (e) {
        if (e?.name === 'AbortError' || e?.code === 'ABORT_ERR') throw e;
        log('[otp] AYCD failed: ' + ((e && e.message) || e) + (c.host ? ' — falling back to this profile’s IMAP' : ''), taskId);
      }
    }
    if (!c.host || !c.user || !c.password) {
      if (!aycdKey) log('[otp] no OTP source configured — add an IMAP mailbox to the matching profile, or enter the code manually', taskId);
      return;
    }
    const script = path.join(botDir, 'imap-client.mjs');
    if (!fs.existsSync(script)) { log('[otp] mailbox reader is missing from this Zyn installation', taskId); return; }
    log('[otp] checking the selected profile mailbox for the Target code', taskId);
    const { fetchAuthCode } = await import(pathToFileURL(script).href);
    // Relaxed recipient matching is safe for one login using this mailbox. With several tasks on
    // one mailbox, require exact recipients so one task cannot consume another account's code.
    const mailboxKey = `${String(c.host).toLowerCase()}|${String(c.user).toLowerCase()}`;
    const currentPending = otpPending.get(key);
    if (currentPending) currentPending.mailboxKey = mailboxKey;
    const mailboxWaiters = [...otpPending.values()].filter(p => p.mailboxKey === mailboxKey).length;
    const soloLogin = mailboxWaiters <= 1;
    if (!soloLogin) log(`[otp] ${mailboxWaiters} logins share this mailbox — matching each code to its exact recipient`, taskId);
    const result = await fetchAuthCode(
      { host: c.host, port: c.port, user: c.user, password: c.password },
      addr,
      /(\d{6})/,
      240000,
      {
        fromFilter: 'target', relaxTo: soloLogin, signal: fetchState.controller.signal, receivedAfter,
        onLog: (line) => log(String(line), taskId),
      },
    );
    if (result && result.code) { deliver(result.code); return; }
    log('[otp] no new Target code was found in this mailbox', taskId);
  } catch (e) {
    if (e?.name === 'AbortError' || e?.code === 'ABORT_ERR') vlog('[otp] mailbox fetch cancelled', taskId);
    else log('[otp] mailbox fetch failed: ' + ((e && e.message) || e), taskId);
  } finally {
    if (otpFetches.get(key) === fetchState) otpFetches.delete(key);
  }
}
