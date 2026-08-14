// IMAP client to fetch authentication codes from emails.
//
// Polls the mailbox every few seconds until a matching, code-bearing message shows up or the
// timeout elapses — a single search pass (the old behavior) usually loses the race against the
// email actually arriving. Bounds the search to the last 10 minutes so a bulk run sharing one
// inbox across many aliases can't pick up a stale code from an earlier run.
//
// BUG FIX (2026-07-18, found via a live run that grabbed a stale code from an OLDER email meant
// for a different address): messages were fetched and parsed IN PARALLEL, so whichever one's body
// stream finished reading first won — not actually "newest first" despite the old comment. Worse,
// there was no verification in code that the matched message was actually addressed to
// targetEmail — it trusted the IMAP server's TO search criterion alone with no fallback check. Now
// fetches strictly sequentially (newest UID first) and explicitly checks the parsed To: header
// against targetEmail before ever accepting a code, regardless of whether the server-side search
// filtered correctly.

import Imap from 'imap';
import { simpleParser } from 'mailparser';

const POLL_INTERVAL_MS = 3000;
const SEARCH_WINDOW_MS = 10 * 60 * 1000;

export async function fetchAuthCode(imapConfig, targetEmail, codePattern = /(\d{6})/i, timeoutMs = 60000, { onLog, fromFilter = 'p-bandai', relaxTo = false } = {}) {
  const log = onLog || (() => {});
  return new Promise((resolve, reject) => {
    const imap = new Imap({
      user: imapConfig.user,
      password: imapConfig.password,
      host: imapConfig.host,
      port: imapConfig.port || 993,
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
    });

    let settled = false;
    let pollTimer = null;
    const deadline = Date.now() + timeoutMs;
    const targetLower = (targetEmail || '').toLowerCase();

    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      if (pollTimer) clearTimeout(pollTimer);
      try { imap.end(); } catch {}
      fn(val);
    };

    imap.once('error', (err) => finish(reject, err));

    imap.once('ready', () => {
      imap.openBox('INBOX', false, (err, box) => {
        if (err) { finish(reject, err); return; }
        log(`  [IMAP] Connected as ${imapConfig.user} — INBOX has ${box.messages.total} message(s) total.`);
        poll();
      });
    });

    // Diagnostic-only, fired once right before we give up: a broad SINCE-only search (no FROM/TO)
    // to show what's ACTUALLY sitting in the inbox in the search window. Distinguishes "nothing
    // reached this mailbox at all" (connectivity/access issue, e.g. iCloud Advanced Data Protection
    // silently blocking third-party IMAP) from "mail is there but doesn't match FROM/TO" (wrong
    // sender address, or forwarding/alias rewriting the To: header).
    function dumpInboxDiagnostic(cb) {
      imap.search([['SINCE', new Date(Date.now() - SEARCH_WINDOW_MS)]], (err, results) => {
        if (err) { log(`  [IMAP] Diagnostic search failed: ${err.message}`); cb(); return; }
        if (!results || !results.length) {
          log(`  [IMAP] Diagnostic: 0 message(s) in INBOX in the last ${Math.round(SEARCH_WINDOW_MS / 60000)} min (any sender). If you can see the email in Mail.app, this account/mailbox likely isn't reachable over IMAP — check that iCloud Advanced Data Protection is OFF for this Apple ID (it silently disables third-party IMAP access), and that the app-specific password hasn't been revoked.`);
          cb();
          return;
        }
        const uids = [...results].sort((a, b) => b - a).slice(0, 10);
        log(`  [IMAP] Diagnostic: ${results.length} message(s) in INBOX in the last ${Math.round(SEARCH_WINDOW_MS / 60000)} min (any sender) — showing up to ${uids.length} newest:`);
        const f = imap.fetch(uids, { bodies: 'HEADER.FIELDS (FROM TO SUBJECT DATE)' });
        let pending = uids.length;
        f.on('message', (msg) => {
          let buf = '';
          msg.on('body', (stream) => { stream.on('data', (chunk) => { buf += chunk.toString('utf8'); }); });
          msg.once('end', () => {
            const get = (name) => (buf.match(new RegExp(`^${name}:\\s*(.*)$`, 'im')) || [])[1] || '';
            log(`    From: ${get('From')} | To: ${get('To')} | Subject: ${get('Subject')} | Date: ${get('Date')}`);
            if (--pending === 0) cb();
          });
        });
        f.once('error', (err) => { log(`  [IMAP] Diagnostic fetch failed: ${err.message}`); cb(); });
      });
    }

    function poll() {
      if (settled) return;
      if (Date.now() > deadline) {
        dumpInboxDiagnostic(() => {
          finish(reject, new Error(`Auth code not found within ${timeoutMs}ms`));
        });
        return;
      }

      // TO is still sent as a coarse server-side pre-filter (cuts down what we fetch), but it is
      // NOT trusted alone — fetchOne() below re-checks the real parsed To: header before accepting.
      //
      // BUG FIX (2026-07-18, found via a live run that timed out despite the user confirming the
      // email had actually arrived): this used to also require 'UNSEEN', which silently excludes
      // any message already marked as read — e.g. auto-marked-read by a push notification, or by
      // opening it in another mail client/device on the same account. The SINCE window (10 min) +
      // FROM + the explicit To: header re-check in fetchOne() already bound this search tightly
      // enough without needing UNSEEN, so it's dropped — this now matches the code whether or not
      // the message has been read.
      // BUG FIX (2026-07-24, found via the [IMAP] diagnostic dump on a live timeout): iCloud's Hide
      // My Email relay rewrites the From: header on every forwarded message into a unique
      // obfuscated per-message address (e.g. "info-us_at_p-bandai_com_<random>@icloud.com") instead
      // of passing through the real "info-us@p-bandai.com" — so an exact-address FROM match can
      // never hit for an HME-relayed account. IMAP's FROM search is a substring match already (not
      // exact), and Apple's obfuscation still contains the sender's text verbatim including hyphens
      // ("..._at_p-bandai_com_..."), so narrowing to just "p-bandai" matches both a direct literal
      // sender (Gmail/Yahoo, no relay involved) and the HME-rewritten form.
      // fromFilter narrows by sender (substring match). Defaults to 'p-bandai' so existing callers
      // are unchanged; Walmart OTP passes 'walmart'. Empty string = no FROM pre-filter.
      // relaxTo (2026-07-25, found on a live Target run): the mailbox being polled is often NOT the
      // address the code is addressed to — a catch-all, a forwarder, or a shared inbox serving many
      // aliases. A server-side ['TO', targetEmail] then returns ZERO hits, so we poll until timeout
      // without ever fetching the message that's sitting right there. When relaxTo is set we drop the
      // TO criterion and instead PREFER a To:-match in fetchOne(), falling back to the newest
      // code-bearing message from this sender if no message in the window is addressed to us.
      const criteria = [
        ['SINCE', new Date(Date.now() - SEARCH_WINDOW_MS)],
      ];
      if (fromFilter) criteria.unshift(['FROM', fromFilter]);
      if (targetEmail && !relaxTo) criteria.push(['TO', targetEmail]);

      imap.search(criteria, (err, results) => {
        if (settled) return;
        if (err) { finish(reject, err); return; }
        if (!results || !results.length) {
          pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
          return;
        }
        const uids = [...results].sort((a, b) => b - a); // newest UID first
        fetchOne(uids, 0);
      });
    }

    // Sequential, newest-first: fetch ONE message, verify it, and only move to the next UID if
    // this one isn't actually addressed to targetEmail (or has no code) — no parallel race.
    function fetchOne(uids, idx, fallback) {
      if (settled) return;
      if (idx >= uids.length) {
        // Whole window scanned with no To:-match. In relaxTo mode accept the newest code-bearing
        // message from this sender rather than timing out, and say plainly whose address it bore.
        if (relaxTo && fallback) {
          log(`  [IMAP] No message addressed to ${targetEmail} — using newest ${fromFilter} code in the window (To: ${fallback.matchedTo || 'unknown'}).`);
          finish(resolve, fallback);
          return;
        }
        pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
        return;
      }

      const f = imap.fetch([uids[idx]], { bodies: '', markSeen: true });
      let buf = '';
      f.on('message', (msg) => {
        msg.on('body', (stream) => {
          stream.on('data', (chunk) => { buf += chunk.toString('utf8'); });
        });
      });
      f.once('error', (err) => finish(reject, err));
      f.once('end', async () => {
        if (settled) return;
        try {
          const parsed = await simpleParser(buf);
          const toText = (parsed.to && parsed.to.text || '').toLowerCase();
          const text = parsed.text || parsed.html || '';
          const match = text.match(codePattern);
          if (targetLower && !toText.includes(targetLower)) {
            // Passed the server-side TO filter (or no filter was applied) but isn't actually
            // addressed to us — do NOT accept its code. Check the next-older message instead.
            // In relaxTo mode keep the newest such message as a last-resort fallback (see above).
            const next = (relaxTo && !fallback && match)
              ? { code: match[1], matchedTo: (parsed.to && parsed.to.text) || '' }
              : fallback;
            fetchOne(uids, idx + 1, next);
            return;
          }
          if (match) { finish(resolve, { code: match[1], matchedTo: (parsed.to && parsed.to.text) || '' }); return; }
          fetchOne(uids, idx + 1, fallback);
        } catch {
          fetchOne(uids, idx + 1, fallback);
        }
      });
    }

    imap.connect();
  });
}
