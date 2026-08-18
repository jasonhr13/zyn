// Turn the engine's internal chatter into something a customer can read.
//
// The logs are written for whoever is debugging the engine: Target's internal hostnames, the
// engine's own step ids, task uuids, proxy gateways, antibot vendor names. A user sees all of it and
// cannot tell a routine retry from a real failure — and it tells anyone looking over their shoulder
// exactly how the thing is built.
//
// TWO AUDIENCES, ONE PIPELINE:
//   dev / verbose  →  the raw line, untouched. Debugging needs the hostname and the step id.
//   shipped build  →  a short plain sentence, or nothing.
//
// ALLOW-LIST, NOT SANITISE. The first version of this file rewrote lines with a table of regexes,
// and it was wrong in both directions on the first ten real samples: a pattern meant to strip
// "[ID:'target-monitor' …]" swallowed the poll counts inside it, and a half-substituted URL still
// leaked `redsky` into the output. Sanitising arbitrary text means every line you did not think of
// leaks by DEFAULT.
//
// So: a line is shown only if it matches something here and is rewritten from scratch. Anything
// unrecognised is dropped. New engine chatter is then invisible rather than raw, which is the safe
// direction to fail — and the dev build still shows everything, so nothing is lost while debugging.

// [pattern, build] — build(match) returns the user-facing sentence, or '' to drop.
// Order matters: first match wins, so specific patterns come before general ones.
const RULES = [
  // ── outcomes the user genuinely wants ────────────────────────────────────
  [/successfully placed order\s+(\S+)/i, (m) => `Order placed — ${m[1]}`],
  [/\bcheckout success|\bsuccessful\b/i, () => 'Checkout successful'],
  [/payment (declined|rejected)/i, () => 'Payment declined'],
  [/\bcard.*(declined|rejected)/i, () => 'Payment declined'],
  [/out of stock|OOS\b/i, () => 'Out of stock'],
  [/\bin stock\b/i, () => 'In stock — carting'],
  [/added to cart|carted/i, () => 'Added to cart'],
  [/\bqueue|waiting room/i, () => 'In the queue'],

  // ── progress worth seeing ────────────────────────────────────────────────
  [/monitor watching (\d+) SKU/i, (m) => `Watching ${m[1]} item${m[1] === '1' ? '' : 's'}`],
  [/(\d+) task\(s\) started/i, (m) => `${m[1]} task(s) started`],
  [/polls (\d+)\/(\d+) \((\d+)%\)/i, (m) => `Stock checks: ${m[1]} of ${m[2]} OK (${m[3]}%)`],
  [/bank: login=\d+ atc=(\d+)/i, (m) => `Security cookies ready: ${m[1]}`],
  [/\[IMAP\] Connected/i, () => 'Mailbox connected — waiting for the email code'],
  [/\[IMAP\] Ignoring stale/i, () => 'Ignoring an older email — waiting for the new code'],
  [/checking the selected profile mailbox/i, () => 'Checking the profile mailbox'],
  [/checking AYCD Inbox/i, () => 'Checking AYCD Inbox for the email code'],
  [/code found .*submitting/i, () => 'Email code found — submitting'],
  [/mailbox fetch failed|Auth code not found|no new Target code/i, () => 'Could not find the new email code — enter it manually'],
  [/no OTP source configured|mailbox reader is missing/i, () => 'Automatic email codes are unavailable — enter it manually'],
  [/signing in|logging in|login success/i, () => 'Signing in'],
  [/verification code|otp/i, () => 'Waiting for the email code'],

  // ── failures, said plainly and without naming the wall ───────────────────
  [/proxy blocked|\b403\b|proxy block/i, () => 'Blocked — trying another connection'],
  [/proxy failed|connection reset|unexpected EOF|ECONNRESET/i, () => 'Connection failed — retrying'],
  [/failed to respond|i\/o timeout|timeout exceeded|timed? ?out/i, () => 'No response — retrying'],
  [/401|unauthorized|session expired/i, () => 'Session expired — signing in again'],
  [/rate.?limit|DCO_RATE_LIMITED/i, () => 'Target is rate limiting — slowing down'],
  [/captcha/i, () => 'A security check appeared'],
  [/refusing to checkout|unexpected cart items/i, () => 'Stopped — the cart held an unexpected item'],
  [/no atc|cart_items never fired/i, () => 'Could not prepare a security cookie — retrying'],
  [/shape block \(precart\)/i, () => 'Security cookie rejected before carting — retrying'],
  [/shape block \(cart\)/i, () => 'Security cookie rejected at add to cart — retrying'],

  // ── task lifecycle ───────────────────────────────────────────────────────
  [/task\(s\) stopp?ed|stopping task/i, () => 'Stopped'],
  [/^\s*\d+ task\(s\)/i, (m) => m[0].trim()],
];

// Returns the plain-language line, or '' to drop it.
function plainify(line) {
  const raw = String(line == null ? '' : line);
  if (!raw.trim()) return '';
  for (const [re, build] of RULES) {
    const m = re.exec(raw);
    if (m) {
      const out = String(build(m) || '').trim();
      return out;
    }
  }
  return '';   // unrecognised → not shown. Fail closed, not open.
}

// A last guard for anything that reaches the log by another route: even if a rule is written badly,
// these must never appear in a shipped build.
const FORBIDDEN = /redsky|carts?\.target|api\.target|gsp\.target|lndg\.page|cmpgn\.page|shortstack|capsolver|anti-?captcha|capmonster|2captcha|cloudflare|turnstile|perimeterx|\bshape\b|target-monitor|\bt_[a-z0-9]{6,}\b|\d{1,3}(\.\d{1,3}){3}|goroutine|\.go:\d+/i;

function leaksInternals(line) {
  return FORBIDDEN.test(String(line || ''));
}

module.exports = { plainify, leaksInternals, RULES, FORBIDDEN };
