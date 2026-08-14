// Round1 / ShortStack registration — one task, one profile, one browser.
//
// Ported from Round1-Register/register.mjs, which registered successfully on 2026-07-17. The form
// logic is kept verbatim because it is PROVEN: inspect-and-tag, the store matcher, the re-click
// window, and the Cloudflare stand-down all came from a run that ended in "SUCCESS — you are
// registered". What changed is everything around it, so Zyn can run many of these at once:
//
//   • profile + proxy + URL arrive as CLI args instead of a hardcoded CONFIG block
//   • a per-task proxy (register.mjs had none — it went out on the operator's home IP)
//   • off-screen headed instead of headless, see the launch comment
//   • a coherent per-task persona, so N tasks do not look like one script run N times
//   • @@STATUS lines so the task board shows what each one is doing
//
// Usage:
//   node round1-register.mjs --url=https://round1usa.cmpgn.page/XXXX \
//     --first=Ada --last=Lovelace --email=a@b.com --store="TX Willowbrook Mall" \
//     [--marketing=true] [--proxy=host:port:user:pass] [--offscreen=false] [--giveUpHours=16]
import { chromium } from 'playwright';
// Only makePersona + createHuman: the persona seeds human INPUT pacing (curved pointer paths,
// variable typing), which spoofs nothing. personaInitScript/makeContextOptions are deliberately
// unused — see the comment in main().
import { makePersona, createHuman } from './harvest-persona.mjs';
import { createHash } from 'crypto';
import { spawn } from 'child_process';

const argOf = (name, def = '') => {
  const p = process.argv.find((a) => a.startsWith(`--${name}=`));
  return p ? p.slice(name.length + 3) : def;
};

const URL_ARG = argOf('url');
const PROFILE = {
  first: argOf('first'),
  last: argOf('last'),
  email: argOf('email'),
  store: argOf('store'),
  marketing: argOf('marketing', 'false') === 'true',
};
const PROXY_RAW = argOf('proxy');
const OFFSCREEN = argOf('offscreen', 'true') !== 'false';
// Exit code meaning "this IP drew an interactive challenge — respawn me on a different one". Distinct
// from 0/1 so the parent never confuses it with success, a crash, or a user stop.
const ROTATE_EXIT = 75;
// How long to let a visible widget try to pass by itself before giving up on the session.
const INTERACTIVE_GRACE_MS = 8000;
// Rehearsal only: pretend Cloudflare served the interactive checkbox, so the rotation path can be
// exercised without waiting for a real one. Cloudflare decides that per session and cannot be asked
// for it, which would otherwise make this branch untestable until it mattered.
// "true"   — claim the checkbox appeared, then judge the grace window honestly (proves we do NOT
//             rotate a session that was about to pass).
// "rotate" — also pretend the grace window found nothing, so the rotation path itself runs.
const SIMULATE_INTERACTIVE = /^(true|rotate)$/i.test(argOf('simulateInteractive', 'false'));
const SIMULATE_ROTATE = /^rotate$/i.test(argOf('simulateInteractive', 'false'));
// Human-paced typing is OFF by default. Measured 2026-07-29 on the mock: paced 6.92s for three text
// fields, direct 0.02s. It defends against nothing here — Turnstile issues its token on page LOAD,
// before the form is touched (the log shows "CF solved" ahead of "form open"), and ShortStack's own
// config has enable_entry_recaptcha:false, so there is no second behavioural check. Against a 9,000
// place cap those seconds are the whole game. --humanFill=true restores the pacing if a future
// campaign turns on a check that watches input.
const HUMAN_FILL = argOf('humanFill', 'false') === 'true';
let TEST_MODE = false;   // set in main() once the url is resolved
const GIVE_UP_MS = (parseFloat(argOf('giveUpHours', '16')) || 16) * 3600 * 1000;

// Timings carried over from the working script.
const RELOAD_MS = 20000;
const DOM_POLL_MS = 1500;
// How long to let the page BUILD ITSELF before calling it blank.
//
// The served HTML contains no form — no input, select, form, button or iframe. The body is literally
// one empty <div id="tw_container">, and ShortStack renders everything into it from window.bootData
// in JavaScript. So "has it loaded" is not a network question, it is "has the app finished running".
// 8s was enough on a home connection and is not through a proxy, where the bundles arrive slower —
// which is exactly how a perfectly healthy page came back as text=0 chars.
const STUCK_MS = 30000;
const SUBMIT_WINDOW_MS = 60000;
const RECLICK_MS = 2500;
const MAX_ATTEMPTS = 3;      // the cap that stops a flaky form producing duplicate entries

const log = (m) => console.log(`[${new Date().toLocaleTimeString()}] ${m}`);
// Beta users do not need to know what Turnstile is, how long a token was, or which stage we are in —
// that vocabulary reads as something going wrong even when it is going right. The diagnostic detail
// is kept, just behind --verbose=true, so an admin build still sees everything.
const VERBOSE = argOf('verbose', 'false') === 'true';
const vlog = (m) => { if (VERBOSE) log(m); };
// Cloudflare state, reported separately from the task state so the board can show both at once —
// "watching" and "cf: solved" are different facts and collapsing them hid which was which.
let cfState = '';
const emitCf = (state, detail = '') => {
  if (state === cfState) return;      // only on change; this is polled every second
  cfState = state;
  console.log(`@@CF ${state}|${detail}`);
};
// The task board parses these; keep the vocabulary aligned with the other engines.
const emitStatus = (state, detail = '') => console.log(`@@STATUS ${state}|${detail}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Playwright words a torn-down execution context exactly like a browser that has really gone away,
// and a Turnstile that passes navigates the page out from under an in-flight evaluate — so the usual
// cause of this message is a page that is very much alive. Ask the browser directly, because the
// message on its own cannot tell the two apart. Matching a bare "closed" was worse still: it also
// caught net::ERR_CONNECTION_CLOSED, turning an ordinary flaky proxy into a fatal error.
const isDeadBrowser = (e, page) => {
  try {
    if (page && !page.isClosed()) {
      const b = page.context() && page.context().browser();
      if (!b || b.isConnected()) return false;
    }
  } catch {}
  return /Target page, context or browser has been closed|Browser has been closed|Target closed/i.test(String(e && e.message));
};

// --url=test (or Test) serves bot/round1-mock.html from an ephemeral local port and points the browser
// at that. Self-contained on purpose: Turnstile needs a real http origin — it will not run on file://
// — and requiring a separate server to be running first is a step nobody remembers under pressure.
// Append a mode with test:interactive / test:block / test:invisible; see the mock's own header.
async function serveMock(mode) {
  const http = await import('node:http');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const url = await import('node:url');
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const html = fs.readFileSync(path.join(here, 'round1-mock.html'), 'utf8');
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return { url: `http://127.0.0.1:${port}/?cf=${mode || 'pass'}`, close: () => { try { server.close(); } catch {} } };
}

// host:port alone is not enough to tell two lines apart. The in-house pools are 50,000 lines across
// FOUR gateway hostnames — the username carries a session token, and that token is what selects the
// exit IP. Logging only host:port therefore makes a rotation look like a no-op. A short hash of the
// whole line distinguishes sessions without putting any credential material in the log.
function proxyLabel(raw) {
  if (!raw) return 'none (home IP)';
  // The gateway hostname is deliberately NOT printed. These logs get pasted into
  // Discord whenever a run misbehaves, and the provider is the one detail worth
  // not handing out. The session hash keeps the thing the log actually needs —
  // telling one line from another, so a rotation is visibly a rotation.
  const sid = createHash('sha1').update(String(raw)).digest('hex').slice(0, 6);
  return `session ${sid}`;
}

// ── Brute-force autofill, for the on-page helper bar ─────────────────────────────────────────────
// Runs IN THE PAGE, so it must stay self-contained — no closures over module scope.
//
// Deliberately not the same code path as the automated fill. That one relies on inspectAndTagPage
// having tagged the fields, which is exactly what has already failed if a human is reaching for this
// button. This one re-derives every field from scratch, tries several strategies per field, falls
// back to position when meaning fails, and always reports what it managed rather than throwing.
function bruteFillInPage(p) {
  const R = { done: [], missed: [], notes: [] };
  const inBar = (el) => { try { return !!(el.closest && el.closest('#__r1_bar')); } catch { return false; } };
  const vis = (el) => {
    if (!el || el.disabled || el.readOnly || inBar(el)) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  };
  // React and Vue keep their own record of a node's last value and treat a plain `el.value = x` as a
  // no-op, so the framework never sees the change and the site submits an empty field. Going through
  // the prototype's native setter is what makes it register. This is the whole reason a naive
  // autofill "fills" a form that then rejects as blank.
  const setVal = (el, val) => {
    try {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
        : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
      const d = Object.getOwnPropertyDescriptor(proto, 'value');
      if (d && d.set) d.set.call(el, val); else el.value = val;
    } catch { try { el.value = val; } catch {} }
    for (const t of ['input', 'change', 'keyup', 'blur']) {
      try { el.dispatchEvent(new Event(t, { bubbles: true })); } catch {}
    }
  };
  const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  // Everything a person would read to work out what a field is for.
  const hay = (el) => {
    const bits = [el.name, el.id, el.placeholder, el.getAttribute('aria-label'),
      el.getAttribute('autocomplete'), el.getAttribute('data-testid'), el.type];
    try { if (el.labels) for (const l of el.labels) bits.push(l.innerText); } catch {}
    try {
      if (el.id) { const lf = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (lf) bits.push(lf.innerText); }
    } catch {}
    try { const lc = el.closest('label'); if (lc) bits.push(lc.innerText); } catch {}
    let n = el.parentElement;
    for (let d = 0; d < 3 && n; d++, n = n.parentElement) bits.push((n.innerText || '').slice(0, 100));
    return norm(bits.join(' '));
  };

  const HONEY = /(^| )(website|url|company|honeypot|fax|nickname)( |$)/;
  const all = [...document.querySelectorAll('input, textarea')].filter(vis);
  const texts = all.filter((el) => {
    const t = (el.getAttribute('type') || 'text').toLowerCase();
    if (!['text', 'email', 'tel', 'search', ''].includes(t) && el.tagName !== 'TEXTAREA') return false;
    return !HONEY.test(' ' + norm([el.name, el.id, el.placeholder].join(' ')) + ' ');
  });
  const boxes = all.filter((el) => el.type === 'checkbox');
  const taken = new Set();
  const pick = (re, preferType) => {
    let best = null, bestScore = -1;
    for (const el of texts) {
      if (taken.has(el)) continue;
      let s = -1;
      if (preferType && (el.getAttribute('type') || '').toLowerCase() === preferType) s = 100;
      const h = hay(el);
      if (re.test(h)) s = Math.max(s, 50 - h.indexOf(h.match(re)[0]) / 100);
      if (s > bestScore) { bestScore = s; best = el; }
    }
    if (best && bestScore >= 0) { taken.add(best); return best; }
    return null;
  };

  let email = pick(/e ?mail/, 'email');
  const email2 = pick(/confirm|verify|re ?enter|again/);
  let first = pick(/first|fname|given|forename/);
  let last = pick(/last|lname|surname|family/);
  // Phase 3 added "Which phase of the Card Game sale is this? (Enter #, e.g., 1, 2, 3)".
  //
  // Claimed HERE, before the positional fallback below, for two reasons. Left unclaimed it stays in
  // `spare`, so a name whose label did not match would be shifted straight into it -- a wrong answer
  // on a required field, silently. And if nothing was shifted it would simply stay empty, which
  // fails validation just as hard.
  //
  // The number is read from the page rather than hardcoded, so Phase 4 needs no code change; 3 is
  // only the fallback for when the wording changes and the regex finds nothing.
  const phase = pick(/which phase|phase of the|enter #/);
  const phaseVal = (() => {
    const m = /phase\s*(\d+)/i.exec(document.body.innerText || '');
    return m ? m[1] : '3';
  })();
  // Meaning failed — fall back to position. On a two-name form the order is first, last, essentially
  // always, and a wrong guess is recoverable by hand whereas an empty form is not.
  const spare = texts.filter((el) => !taken.has(el));
  if (!first && spare.length) { first = spare.shift(); R.notes.push('first name matched by position'); }
  if (!last && spare.length) { last = spare.shift(); R.notes.push('last name matched by position'); }
  if (!email && spare.length) { email = spare.shift(); R.notes.push('email matched by position'); }

  const put = (el, val, name) => {
    if (!el) { R.missed.push(name); return; }
    setVal(el, val);
    const got = String(el.value || '').trim();
    if (got === String(val).trim()) R.done.push(name);
    else { R.missed.push(name + ' (reads "' + got.slice(0, 24) + '")'); }
  };
  put(first, p.first, 'first');
  put(last, p.last, 'last');
  put(email, p.email, 'email');
  if (email2) put(email2, p.email, 'confirm email');
  // Only reported as missed when the field EXISTS and could not be filled -- on a form without the
  // phase question (Phase 2 and earlier) its absence is normal, not a failure.
  if (phase) put(phase, phaseVal, 'phase');

  // ── store ────────────────────────────────────────────────────────────────────────────────────
  // Round1 has flipped the format between phases ("Name ST" -> "ST Name"), so exact-match alone is
  // not enough; fall through progressively looser rules rather than give up.
  const want = norm(p.store);
  const wantWords = want.split(' ').filter(Boolean);
  const selects = [...document.querySelectorAll('select')].filter(vis);
  let storeDone = false;
  for (const sel of selects.sort((a, b) => b.options.length - a.options.length)) {
    const opts = [...sel.options];
    const score = (o) => {
      const t = norm(o.textContent);
      if (!t) return 0;
      if (t === want) return 4;
      if (wantWords.length && wantWords.every((w) => t.includes(w))) return 3;
      if (t.includes(want) || want.includes(t)) return 2;
      const hits = wantWords.filter((w) => t.includes(w)).length;
      return hits >= 2 ? 1 : 0;
    };
    let best = null, bestS = 0;
    for (const o of opts) { const s = score(o); if (s > bestS) { bestS = s; best = o; } }
    if (best && bestS > 0) {
      sel.value = best.value;
      for (const t of ['input', 'change']) { try { sel.dispatchEvent(new Event(t, { bubbles: true })); } catch {} }
      storeDone = norm(opts[sel.selectedIndex] && opts[sel.selectedIndex].textContent) === norm(best.textContent);
      R.done.push('store → ' + best.textContent.replace(/\s+/g, ' ').trim() + (bestS < 4 ? ' (fuzzy)' : ''));
      break;
    }
  }
  if (!storeDone && !R.done.some((d) => d.startsWith('store'))) {
    // Some builds use a text/combobox for the store instead of a <select>.
    const box = texts.find((el) => !taken.has(el) && /store|location|pickup|venue/.test(hay(el)));
    if (box) { setVal(box, p.store); R.done.push('store (typed into a text field)'); }
    else R.missed.push('store — ' + (selects.length ? 'no option matched "' + p.store + '"' : 'no dropdown on this page'));
  }

  // ── checkboxes ───────────────────────────────────────────────────────────────────────────────
  // click() first so the site's own handler runs; only force the property if the click did not take.
  const setBox = (el, want2) => {
    if (!el || el.checked === want2) return el ? true : false;
    try { el.click(); } catch {}
    if (el.checked !== want2) {
      try { el.checked = want2; el.dispatchEvent(new Event('change', { bubbles: true })); } catch {}
    }
    return el.checked === want2;
  };
  const MARKET = /offer|deal|newsletter|latest|updates|marketing|subscribe|email me/;
  let terms = 0, news = 0;
  for (const b of boxes) {
    const h = hay(b);
    if (MARKET.test(h)) { if (setBox(b, !!p.marketing)) news++; continue; }
    if (b.required || /agree|terms|consent|rule|eligib|privacy|policy|confirm/.test(h)) { if (setBox(b, true)) terms++; }
  }
  if (terms) R.done.push('agreed ' + terms + ' box' + (terms > 1 ? 'es' : ''));
  if (news) R.done.push('marketing ' + (p.marketing ? 'on' : 'off'));
  if (!boxes.length) R.notes.push('no checkboxes found');
  return R;
}

// Copy via a child process rather than navigator.clipboard, which needs document focus and is
// unreliable in an automated window. Same approach as the P-Bandai bar.
function copyToClipboard(text) {
  return new Promise((resolve) => {
    try {
      const cmd = process.platform === 'win32' ? 'clip' : process.platform === 'darwin' ? 'pbcopy' : 'xclip';
      const c = spawn(cmd, process.platform === 'linux' ? ['-selection', 'clipboard'] : []);
      c.on('error', () => resolve(false));
      c.on('close', (code) => resolve(code === 0));
      c.stdin.on('error', () => {});
      c.stdin.end(String(text == null ? '' : text), 'utf8');
    } catch { resolve(false); }
  });
}

// ── On-page helper bar ───────────────────────────────────────────────────────────────────────────
// Visible runs only. Several identical Chrome windows are otherwise indistinguishable, and when one
// stalls you finish by hand with no idea which signup you are looking at. Mirrors the P-Bandai bar.
//
// A console-message channel, NOT exposeFunction: its injected wrapper calls a CDP binding on the
// global, which the init script and any context recreation can disturb, and then every click throws.
// The console channel needs no binding and re-attaches per page for free.
async function installHelperBar(context, profile) {
  const runFill = async (page) => {
    // All frames: the form is sometimes inside one, and the top document then has nothing to fill.
    const reports = [];
    for (const f of page.frames()) {
      const r = await f.evaluate(bruteFillInPage, profile).catch(() => null);
      if (r && (r.done.length || r.missed.length)) reports.push(r);
    }
    if (!reports.length) return 'nothing fillable found on this page';
    const done = reports.flatMap((r) => r.done);
    const missed = reports.flatMap((r) => r.missed);
    const notes = reports.flatMap((r) => r.notes);
    log(`autofill — filled: ${done.join(', ') || 'nothing'}${missed.length ? ` · missed: ${missed.join(', ')}` : ''}`);
    vlog(`  ${notes.join('; ')}`);
    if (!done.length) return 'could not fill anything — see the task log';
    return `filled ${done.length}: ${done.join(', ')}` + (missed.length ? ` · MISSED ${missed.join(', ')}` : ' · review, then submit');
  };

  const handle = async (page, raw) => {
    const m = /^__R1_REQ:([a-z]+)$/.exec(raw);
    if (!m) return;
    let out = '?';
    try {
      if (m[1] === 'autofill') out = await runFill(page);
      else if (m[1] === 'copy') out = (await copyToClipboard(profile.email)) ? 'email copied ✓' : 'copy failed';
    } catch (e) { out = `failed: ${e.message}`; }
    try { await page.evaluate((t) => { const el = document.getElementById('__r1_msg'); if (el) el.textContent = t; }, out); } catch {}
  };
  const wire = (page) => {
    try {
      page.on('console', (msg) => { const t = msg.text(); if (t.startsWith('__R1_REQ:')) handle(page, t).catch(() => {}); });
    } catch {}
  };
  try { for (const p of context.pages()) wire(p); } catch {}
  context.on('page', wire);

  await context.addInitScript((who) => {
    if (window.top !== window || window.__r1Bar) return;   // top frame only
    window.__r1Bar = true;
    const boot = () => {
      if (!document.body || document.getElementById('__r1_bar')) return;
      const bar = document.createElement('div');
      bar.id = '__r1_bar';
      bar.setAttribute('data-r1-bar', '1');
      bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;display:flex;gap:12px;'
        + 'align-items:center;padding:5px 12px;background:#0b0d10;color:#e5e7eb;'
        + 'font:12px/1.4 system-ui,-apple-system,sans-serif;border-bottom:1px solid #1f2937';
      const id = document.createElement('span');
      id.textContent = '👤 ' + who;
      id.style.cssText = 'font-weight:700;color:#4ade80;white-space:nowrap';
      const mk = (text, colour) => {
        const b = document.createElement('button');
        b.textContent = text;
        b.type = 'button';
        b.style.cssText = 'cursor:pointer;padding:2px 10px;border-radius:6px;background:transparent;'
          + `border:1px solid ${colour};color:${colour};font:12px system-ui,sans-serif;white-space:nowrap`;
        return b;
      };
      const bFill = mk('⤵ Autofill', '#38bdf8');
      const bMail = mk('📋 Copy email', '#a78bfa');
      const msg = document.createElement('span');
      msg.id = '__r1_msg';
      msg.style.cssText = 'color:#94a3b8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      const req = (working, cmd) => { msg.textContent = working; console.log('__R1_REQ:' + cmd); };
      bFill.onclick = () => req('filling…', 'autofill');
      bMail.onclick = () => req('copying…', 'copy');
      bar.append(id, bFill, bMail, msg);
      document.body.appendChild(bar);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
    // The campaign is an SPA that replaces its body, which would take the bar with it.
    try { new MutationObserver(boot).observe(document.documentElement, { childList: true, subtree: true }); } catch {}
  }, `${profile.first} ${profile.last} · ${profile.email} · ${profile.store}`);
}

function parseProxy(raw) {
  if (!raw) return null;
  const p = String(raw).split(':');
  if (p.length < 2) return null;
  return { server: `http://${p[0]}:${p[1]}`, username: p[2] || undefined, password: p[3] || undefined };
}

// ── the page logic, unchanged in substance from the proven script ────────────────────────────
// Runs in the PAGE, so it must stay self-contained — no closures over module scope.
function inspectAndTagPage() {
  // The helper bar is our own furniture, not the site's. Its buttons must never be mistaken for the
  // submit button and its text must not count as the page having rendered.
  const inBar = (el) => { try { return !!(el.closest && el.closest('#__r1_bar')); } catch { return false; } };
  const vis = (el) => {
    if (!el || el.disabled || inBar(el)) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none';
  };
  const barEl = document.getElementById('__r1_bar');
  const body = document.body
    ? (document.body.innerText || '').replace(barEl ? (barEl.innerText || '') : ' ', '')
    : '';
  const depth = (el, re) => {
    let n = el;
    for (let d = 1; d <= 6; d++) {
      n = n && n.parentElement;
      if (!n || n === document.body) break;
      if (re.test((n.innerText || '').slice(0, 800))) return d;
    }
    return 99;
  };
  const closest = (c, re) => { let b = null, bd = 99; for (const el of c) { const d = depth(el, re); if (d < bd) { bd = d; b = el; } } return b; };

  const all = [...document.querySelectorAll('input')].filter(vis);
  const HONEYPOT = /website|url|company|honeypot/i;
  const texts = all.filter((i) => ['text', 'email', ''].includes((i.getAttribute('type') || '').toLowerCase()))
    .filter((i) => !HONEYPOT.test(`${i.name || ''} ${i.id || ''} ${i.placeholder || ''}`));
  const boxes = all.filter((i) => i.type === 'checkbox');
  const selects = [...document.querySelectorAll('select')].filter(vis);
  const buttons = [...document.querySelectorAll('button, input[type="submit"], [role="button"]')].filter(vis);

  document.querySelectorAll('[data-r1]').forEach((el) => el.removeAttribute('data-r1'));
  const emails = texts.filter((i) => i.type === 'email');
  const email = emails[0] || closest(texts, /e-?mail/i);
  const email2 = emails[1] || closest(texts.filter((i) => i !== email), /confirm/i) || null;
  const names = texts.filter((i) => i !== email && i !== email2);
  let first = closest(names, /first/i);
  let last = closest(names.filter((i) => i !== first), /last/i);
  if ((!first || !last) && names.length >= 2) { first = names[0]; last = names[1]; }
  let terms = closest(boxes, /agree|terms/i) || boxes[0] || null;
  const news = closest(boxes.filter((c) => c !== terms), /offers|deals|latest|newsletter/i);
  let store = selects[0];
  if (selects.length > 1) store = closest(selects, /location|pickup|store/i) || selects.find((s) => s.options.length > 20) || selects[0];
  const btxt = (b) => (b.innerText || b.value || '').trim().toLowerCase();
  const submit = buttons.find((b) => btxt(b) === 'enter') || buttons.find((b) => /enter|submit|register/.test(btxt(b)))
    || buttons.find((b) => (b.getAttribute('type') || '').toLowerCase() === 'submit');

  const tagged = {};
  const tag = (el, n) => { if (el) { el.setAttribute('data-r1', n); tagged[n] = true; } else tagged[n] = false; };
  tag(first, 'first'); tag(last, 'last'); tag(email, 'email'); tag(email2, 'email2');
  tag(store, 'store'); tag(terms, 'terms'); tag(news, 'news'); tag(submit, 'submit');

  // Two shapes, and missing the second one is why a challenge can look like a blank page:
  //   1. an EMBEDDED widget — a challenges.cloudflare.com iframe sitting on the real form
  //   2. a FULL-PAGE interstitial — "Just a moment…", which has no iframe, almost no text and no
  //      form controls, so the blank/stuck check below matches it and reloads. Every reload restarts
  //      the challenge, so it can never pass, and hammering it is exactly what a bot looks like.
  const embedded = [...document.querySelectorAll('iframe')]
    .some((f) => /challenges\.cloudflare\.com|recaptcha|hcaptcha/i.test(f.src || '') && vis(f));
  // "verify you are human" as well as "verifying" — Cloudflare uses both, and matching only the
  // gerund let the checkbox variant read as an ordinary blank page.
  const interstitial = /just a moment|verif(y|ying) you are human|needs to review the security|checking your browser|enable javascript and cookies/i
    .test(`${document.title || ''} ${body.slice(0, 600)}`);
  //   3. an INVISIBLE Turnstile — no iframe, no text, nothing on screen at all: just
  //        <input type="hidden" name="cf-turnstile-response" id="cf-chl-widget-…">
  //      sitting in the app's mount point while ShortStack refuses to render the form until it is
  //      solved. Observed live on 2026-07-29. Neither check above can see it, so the page reads as
  //      blank and gets reloaded — restarting the very challenge we are waiting on.
  const tok = document.querySelector('input[name="cf-turnstile-response"], input[name*="turnstile-response"], textarea[name*="turnstile"], [id^="cf-chl-widget"], [name="g-recaptcha-response"]');
  const invisible = !!tok && !tok.value;
  const challenge = embedded || interstitial || invisible;

  return {
    tagged,
    storeOptions: store ? [...store.options].map((o) => o.text) : [],
    formReady: !!(tagged.first && tagged.last && tagged.email && tagged.store && tagged.terms && tagged.submit),
    blank: !document.body || (body.trim().length < 40 && all.length === 0 && selects.length === 0 && buttons.length === 0),
    success: /successfully registered|successfully reserved|thank you for (registering|your registration)/i.test(body),
    soldOut: /we have run out of/i.test(body),
    closed: /no longer accepting entries/i.test(body),
    challenge,
    challengeKind: interstitial ? 'full-page interstitial' : embedded ? 'embedded widget' : invisible ? 'invisible Turnstile (form will not render until it passes)' : '',
    hasToken: !!(tok && tok.value),
    // Enough of the page to tell a dead proxy from a real blank from an unrecognised wall. Without
    // it "blank/stuck page" is the only thing the operator ever sees, whatever the actual cause.
    title: (document.title || '').slice(0, 80),
    textLen: body.trim().length,
    // The SPA's mount point. An empty tw_container with the right title means the page arrived but
    // its JavaScript has not built the form — a completely different problem from a page that failed
    // to load, and the two were indistinguishable in the log.
    mounted: (() => { const m = document.getElementById('tw_container'); return m ? m.children.length : -1; })(),
  };
}

// Word-order- and whitespace-insensitive: Phase 1 wrote "Name ST", Phase 2 writes "ST Name", and a
// profile saved under either must still match. Verified against both live phases on 2026-07-29.
function findStoreIndex(options, want) {
  const norm = (t) => String(t).toLowerCase().replace(/\s+/g, ' ').trim();
  const w = norm(want);
  // No store chosen: bail out here. The substring passes below use t.includes(w), and
  // every string includes '', so an empty want would silently select the FIRST option
  // instead of reporting that nothing was picked.
  if (!w) return -1;
  const words = w.split(' ').filter(Boolean);
  const o = (options || []).map(norm);
  let i = o.findIndex((t) => t === w);
  if (i < 0) i = o.findIndex((t) => { const set = new Set(t.split(' ')); return words.length > 0 && words.every((x) => set.has(x)); });
  if (i < 0) i = o.findIndex((t) => t.includes(w));
  if (i < 0 && words[0]) i = o.findIndex((t) => t.includes(words[0]));
  return i;
}

async function launchBrowser() {
  // --disable-blink-features + ignoreDefaultArgs below are LOAD-BEARING, not hygiene. Measured
  // 2026-07-29 against the live campaign, same machine, same IP, minutes apart:
  //
  //   without them   token 0 chars, page blank, for 30s+   (every attempt, home IP and proxies)
  //   with them      token 773-794 chars, page rendered, in 3-4s
  //
  // Turnstile does not challenge an automated browser here, it silently withholds the token forever.
  // There is no error and no visible widget, so removing either line looks like "the proxies went
  // bad" rather than a self-inflicted wound. Do not drop them to quiet a lint.
  const args = ['--disable-blink-features=AutomationControlled'];
  // Off-screen headed, NOT headless. Cloudflare Turnstile scores the browser, and headless is the
  // single loudest signal available to it — the run this was ported from passed with zero challenges
  // precisely because it was a real headed Chrome. Parking the window at -32000,-32000 keeps that
  // fingerprint while getting it off the operator's screen; the three throttling flags stop Windows
  // treating an off-screen window as occluded, which would otherwise freeze rAF and clamp timers and
  // make the session look asleep. Measured identical fps/timerHz to a visible window.
  if (OFFSCREEN) {
    args.push('--window-position=-32000,-32000',
      '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling');
  }
  const opts = { headless: false, args, ignoreDefaultArgs: ['--enable-automation'] };
  const proxy = parseProxy(PROXY_RAW);
  if (proxy) {
    // Playwright sets --proxy-bypass-list=<-loopback>, which forces even 127.0.0.1 through the proxy —
    // so a proxied browser cannot reach a local mock. Bypassing loopback lets ONE browser do both
    // halves of a test run: the real site through the proxy (which is what judges the IP), and the
    // local form directly (which is what measures fill speed).
    opts.proxy = { ...proxy, bypass: 'localhost,127.0.0.1,::1' };
  }
  // Real installed Chrome beats bundled Chromium on every fingerprint surface Turnstile looks at.
  // The proven run used it; fall back only if the channel is missing.
  try { return await chromium.launch({ ...opts, channel: 'chrome' }); }
  catch { return await chromium.launch(opts); }
}

async function main() {
  for (const [k, v] of Object.entries({ url: URL_ARG, first: PROFILE.first, last: PROFILE.last, email: PROFILE.email, store: PROFILE.store })) {
    if (!v) { log(`missing --${k}`); emitStatus('error', `missing --${k}`); process.exit(1); }
  }

  // "test" / "Test" / "test:interactive" -> local mock with a real Turnstile widget.
  let mock = null;
  let targetUrl = URL_ARG;
  // "test" points at a REAL page behind a REAL Cloudflare, on purpose.
  //
  // It used to serve a local mock, which was useless for the question that actually matters: the mock
  // used Cloudflare's always-pass test sitekey, and being on loopback it also had to bypass the proxy.
  // So it could only ever answer "does the fill-and-submit code work" — never "will Cloudflare let
  // this IP through", which is the only thing standing between us and a live drop.
  //
  // Phase 2 is the target because it is a real ShortStack campaign behind the production Turnstile
  // sitekey (0x4AAAAAAASV8uM7MdX_qa2I, identical across phases), so a pass here is a genuine pass.
  // The proxy IS used, so each run qualifies whichever pool is selected.
  //
  // "mock" still serves the offline page for exercising fill-and-submit without touching the site.
  const TEST_URL = 'https://round1usa.cmpgn.page/Rls7N5';   // Phase 3, live 2026-08-03
  const arg = URL_ARG.trim();
  const mockMatch = /^mock(?::(\w+))?$/i.exec(arg);
  // TEST MODE runs two stages in one go, because the two questions need different pages:
  //   1. the REAL campaign, through the proxy — the only thing that can judge whether Cloudflare
  //      will issue a token on this IP. It has no form (the phase is over), so it can go no further.
  //   2. the LOCAL mock, direct — the only place with a working form, so the only way to time a
  //      fill-and-submit. Its Turnstile always passes, so it says nothing about the IP.
  // Neither alone answers "is this pool ready for a drop". Together they do.
  let testStage1 = false;
  if (/^test$/i.test(arg)) {
    testStage1 = true;
    targetUrl = TEST_URL;
    log('Test run — checks the connection, then times a practice fill.');
    vlog(`  1. the real campaign via ${PROXY_RAW ? 'the proxy' : 'your home IP'}, 2. the local form`);
  } else if (mockMatch) {
    TEST_MODE = true;   // the mock is on loopback; a proxy cannot reach it
    mock = await serveMock(mockMatch[1]);
    targetUrl = mock.url;
    log('Practice run — offline form. Tests filling only, not the connection.');
    vlog(`  mock at ${targetUrl} (${mockMatch[1] || 'pass'})${PROXY_RAW ? ' - proxy ignored, it is on 127.0.0.1' : ''}`);
  }

  log(`Round1 — ${PROFILE.first} ${PROFILE.last} <${PROFILE.email}> @ "${PROFILE.store}"`);
  log(`proxy: ${proxyLabel(PROXY_RAW)}`);
  vlog(`proxy ${proxyLabel(PROXY_RAW)} · window: ${OFFSCREEN ? 'off-screen' : 'visible'}`);
  emitStatus('starting', PROFILE.email);

  // NO fingerprint spoofing here, deliberately — measured 2026-07-29 against the live campaign:
  //
  //   plain context   solved , solved , solved
  //   WITH persona    pending , pending , pending
  //
  // Cloudflare does not merely read navigator/WebGL/canvas values, it cross-checks them against each
  // other and against the TLS and HTTP fingerprints underneath, which no init script can reach. Every
  // override is another chance to contradict something real, and plain Chrome is trivially coherent
  // because it is not lying. The persona still earns its place on Target — Shape rewards the
  // behavioural realism that got a0 into the signature — so this is a per-site choice, not a verdict
  // on the persona. What we DO keep is the human input pacing, which spoofs nothing.
  const browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  // Visible runs only. The bar puts a real element in the page, so on an off-screen run — where
  // nobody can click it anyway — it would be pure risk: its text counts toward the "has the form
  // rendered" threshold and its buttons land in the submit-button search.
  if (!OFFSCREEN) await installHelperBar(context, PROFILE).catch((e) => log(`helper bar failed: ${e.message}`));
  const page = await context.newPage();
  const human = createHuman(page, makePersona());

  // Capture the entry id ShortStack hands back when an entry is created.
  //
  // The form posts to app.server_host (https://api.lndg.page) and the response carries the new
  // list-entry id — e.g. 1024613953. Worth having for two reasons. It is PROOF: matching
  // "successfully registered" in the DOM says the page claimed success, whereas an id says the server
  // created a row. And the list id is the SAME across phases (1203548 in both Phase 1 and Phase 2),
  // so these ids are comparable over time and can be quoted if an entry is ever disputed.
  let entryId = '';
  page.on('response', async (res) => {
    try {
      if (entryId) return;
      const u = res.url();
      // Phase 3 moved the campaign to round1usa.cmpgn.page. Same ShortStack engine (bootData,
      // Turnstile, nginx all identical) on a new host, so the entry-id response now arrives from a
      // domain this filter did not know -- it would have returned early and recorded no id at all,
      // silently, with the signup itself still succeeding.
      if (!/lndg\.page|shortstack|cmpgn\.page/i.test(u)) return;
      if (!/post/i.test(res.request().method())) return;
      const ct = (res.headers()['content-type'] || '');
      if (!/json/i.test(ct)) return;
      const body = await res.json().catch(() => null);
      if (!body) return;
      // The id has appeared under several names across ShortStack versions; take the first that
      // looks like an entry id rather than assuming one shape.
      // ONLY explicitly-named entry ids. A bare `id` was accepted at first and immediately grabbed
      // 1203548 — the campaign's LIST id, which is in bootData, identical for every profile, and
      // returned by a page-load call long before any submit. A wrong id is worse than none: it looks
      // like proof of registration while being the same constant every time.
      const dig = (o, d = 0) => {
        if (!o || typeof o !== 'object' || d > 4) return '';
        for (const k of ['entry_id', 'entryId']) {
          const v = o[k];
          if (v != null && /^\d{6,}$/.test(String(v))) return String(v);
        }
        for (const v of Object.values(o)) { const hit = dig(v, d + 1); if (hit) return hit; }
        return '';
      };
      const found = dig(body);
      if (found) {
        entryId = found;
        log(`entry id: ${entryId}`);
        console.log(`@@ENTRY ${entryId}`);
      }
    } catch {}
  });
  vlog('fingerprint: stock Chrome (Cloudflare rejects spoofed contexts on this site)');

  let attempts = 0;
  let challengeWarned = false;
  let challengeSince = 0;
  let cfHeldReported = false;
  let fillStartedAt = 0;   // stage 2 clock, so the reported speed excludes the Cloudflare wait
  let blankStreak = 0;
  let watchCycles = 0;
  let lastWatchState = '';
  let lastNavError = '';
  let formSeen = false;
  const deadline = Date.now() + GIVE_UP_MS;

  const goto = async () => {
    // Say something BEFORE the wait, not after. page.goto can take 45s on a slow proxy and the render
    // poll another 30s, so a silent version leaves the operator staring at nothing for over a minute
    // with no way to tell a working task from a hung one.
    const t0 = Date.now();
    emitStatus('loading', 'opening the campaign page');
    try {
      await page.goto(targetUrl, { timeout: 45000, waitUntil: 'domcontentloaded' });
      log(`connected in ${((Date.now() - t0) / 1000).toFixed(1)}s — waiting for the form`);
      lastNavError = '';
    } catch (e) {
      // Kept rather than rethrown: the caller treats a failed load as "blank" and retries, but
      // without the reason a dead proxy is indistinguishable from a page that renders nothing.
      lastNavError = String(e.message || e).split(/\r?\n/)[0].slice(0, 110);
      // Named immediately. A dead or slow proxy is the single most likely cause of a silent task, and
      // it used to surface only later as a generic "blank/stuck page".
      log('⚠ could not connect — this proxy is not responding');
      vlog(`  ${lastNavError}`);
      emitStatus('error', `nav failed: ${lastNavError.slice(0, 70)}`);
      throw e;
    }
    // Wait for the SPA to put something in its mount point. Checking tw_container specifically —
    // rather than only body text or a form control — catches the case where the app rendered the
    // pre-open placeholder or the closed banner, which are real states we must act on, not "blank".
    const until = Date.now() + STUCK_MS;
    let beat = 0;
    let interactiveSeen = false;
    while (Date.now() < until) {
      // A heartbeat every 10s of the render wait. Turnstile can hold the app for tens of seconds, and
      // without this that is indistinguishable from a hung process.
      if (Date.now() - t0 > (beat + 1) * 10000) {
        beat++;
        log(`  still waiting (${beat * 10}s)…`);
      }
      // Turnstile decides per request whether to pass silently or demand a click, and the two look
      // identical from here: both are a blank page with no form. Naming the difference matters,
      // because only one of them is worth waiting on. A visible challenges.cloudflare.com iframe is
      // the interactive variant — Cloudflare scored this session as suspect and is asking a human.
      if (!interactiveSeen) {
        const iv = SIMULATE_INTERACTIVE || await page.evaluate(() => [...document.querySelectorAll('iframe')].some((f) => {
          if (!/challenges\.cloudflare\.com/i.test(f.src || '')) return false;
          const r = f.getBoundingClientRect();
          const s = getComputedStyle(f);
          return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
        })).catch(() => false);
        if (iv) {
          interactiveSeen = true;
          log('  extra verification requested — waiting to see if it clears…');
          vlog('  (interactive Turnstile checkbox served to this session)');
          emitCf('solving', 'interactive checkbox — waiting to see if it self-resolves');
          // Managed mode can flash a widget and then pass on its own, so do not rotate on sight.
          // Give it a grace window and rotate only if no token has appeared by the end of it —
          // rotating a session that was about to pass throws away a good IP for nothing.
          const graceUntil = Date.now() + INTERACTIVE_GRACE_MS;
          let tok = 0;
          while (Date.now() < graceUntil) {
            tok = SIMULATE_ROTATE ? 0 : await page.evaluate(() => {
              const i = document.querySelector('[name="cf-turnstile-response"]');
              return i && i.value ? i.value.length : 0;
            }).catch(() => 0);
            if (tok) break;
            await sleep(500);
          }
          if (tok) {
            log('    cleared — carrying on.');
            vlog(`    token issued (${tok} chars)`);
            emitCf('solved', `interactive, self-resolved (${tok} chars)`);
          } else {
            log('    did not clear — trying a different proxy.');
            emitCf('failed', 'interactive checkbox — rotating IP');
            emitStatus('rotate', 'interactive Turnstile — trying another proxy');
            try { context.__intentional = true; await browser.close(); } catch {}
            if (mock) mock.close();
            // A dedicated code so the parent can tell "rotate me" from a crash or a user stop.
            process.exit(ROTATE_EXIT);
          }
        }
      }
      const has = await page.evaluate(() => {
        if (!document.body) return false;
        // Discount the helper bar — it is ours, and counting it would make a blank page look rendered.
        const bar = document.getElementById('__r1_bar');
        const barLen = bar ? (bar.innerText || '').trim().length : 0;
        // A pending Turnstile puts its own hidden input into tw_container, so "the mount has
        // children" is true long before the app has rendered anything. Require actual content:
        // real text, or a control that is not the challenge input.
        if (document.body.innerText.trim().length - barLen >= 40) return true;
        if ([...document.querySelectorAll('input, select, button')]
          .some((el) => !(bar && bar.contains(el)) && !/^cf-chl-widget|turnstile/i.test(`${el.id} ${el.name}`))) return true;
        return false;
      }).catch((e) => { if (isDeadBrowser(e, page)) throw e; return false; });
      if (has) return;
      await sleep(250);
    }
  };

  // Clock the whole of stage 1 from BEFORE the navigation. Starting it after goto() returned
  // reported 0.0s, because goto already waits for the render — so the number that mattered
  // (how long Cloudflare took on this IP) was excluded from the measurement of itself.
  const stage1Start = Date.now();
  try { await goto(); } catch (e) { log(`first load failed: ${e.message}`); }

  // ── TEST stage 1: does Cloudflare issue a token on this IP? ──────────────────────────────────
  if (testStage1) {
    const t0 = stage1Start;
    let cleared = false;
    // A tunnel/connection failure means the proxy never reached the site, so there is no Turnstile to
    // wait for — polling the full 40s just delays a verdict we already have. Measured ~14% of a pool
    // dead in one sample, so this is 40 wasted seconds per dead line, every run.
    if (lastNavError && /TUNNEL|ECONNREFUSED|ERR_PROXY|ERR_CONNECTION|ERR_NAME_NOT_RESOLVED|ERR_EMPTY_RESPONSE/i.test(lastNavError)) {
      log('✗ proxy did not connect — this line is dead.');
      vlog(`  ${lastNavError}`);
      emitCf('unknown', 'proxy did not connect');
      emitStatus('error', `dead proxy: ${lastNavError.slice(0, 60)}`);
      try { context.__intentional = true; await browser.close(); } catch {}
      if (mock) mock.close();
      process.exit(0);
    }
    // 40s: a trusted IP is measured at ~3s, and a held one has never come good in testing, so this
    // is generous rather than borderline.
    let evidence = null;
    while (Date.now() - t0 < 40000) {
      const r = await page.evaluate(() => {
        const tok = document.querySelector('[name="cf-turnstile-response"], [id^="cf-chl-widget"]');
        const v = tok && tok.value ? String(tok.value) : '';
        const bar = document.getElementById('__r1_bar');
        const barLen = bar ? (bar.innerText || '').trim().length : 0;
        return {
          solved: !!v,
          rendered: (document.body ? document.body.innerText.trim().length - barLen : 0) > 200,
          tokenLen: v.length,
          // A Turnstile token is long and opaque; the head is enough to prove one exists without
          // logging a credential in full.
          tokenHead: v.slice(0, 18),
          title: document.title,
          textLen: document.body ? document.body.innerText.trim().length : 0,
        };
      }).catch(() => null);
      if (r && (r.solved || r.rendered)) { cleared = true; evidence = r; break; }
      await sleep(1000);
    }
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (cleared) {
      log(`✓ verified in ${secs}s`);
      vlog(`  via ${PROXY_RAW ? proxyLabel(PROXY_RAW) : 'home IP'}`);
      // Say WHICH of the two signals fired. "Cleared" on its own is ambiguous: a Turnstile token is
      // proof, whereas a rendered page is only strong circumstantial evidence (the challenge cannot
      // still be up if the campaign content is on screen).
      if (evidence && evidence.tokenLen) {
        vlog(`  proof: Turnstile token issued — ${evidence.tokenLen} chars, starts "${evidence.tokenHead}…"`);
      } else if (evidence) {
        // Should not happen on this campaign: ShortStack boots the app FROM the Turnstile callback,
        // so content without a token means the DOM changed shape and this check needs revisiting.
        vlog(`  rendered without a token — "${evidence.title}", ${evidence.textLen} chars. Treat as unproven.`);
      }
      emitCf('solved', `cleared in ${secs}s`);
    } else {
      log(`✗ not verified in ${secs}s — ${PROXY_RAW ? 'this proxy is blocked. Try another pool.' : 'your home IP is blocked.'}`);
      emitCf('failed', `no token in ${secs}s`);
      emitStatus('error', 'Cloudflare held this IP — pool not usable');
      try { context.__intentional = true; await browser.close(); } catch {}
      if (mock) mock.close();
      process.exit(0);
    }

    // ── stage 2: the local form, for a real fill-and-submit timing ──────────────────────────────
    mock = await serveMock('pass');
    targetUrl = mock.url;
    log('→ practice form — timing a fill');
    vlog(`  local form at ${targetUrl} (direct, proxy bypassed for loopback)`);
    emitStatus('loading', 'stage 2 — local form');
    fillStartedAt = Date.now();
    try { await goto(); } catch (e) { log(`stage 2 load failed: ${e.message}`); }
  }

  while (Date.now() < deadline) {
    const st = await page.evaluate(inspectAndTagPage).catch((e) => { if (isDeadBrowser(e, page)) throw e; return null; });
    if (!st) { await sleep(1000); continue; }

    if (st.success) { log('✅ registered' + (entryId ? ' · entry ' + entryId : '') + (fillStartedAt ? ' · form-to-submit ' + ((Date.now() - fillStartedAt) / 1000).toFixed(1) + 's' : '')); emitStatus('success', entryId ? PROFILE.email + ' · entry ' + entryId : PROFILE.email); break; }
    if (st.soldOut && formSeen) { log('SOLD OUT — stopping'); emitStatus('soldout', ''); break; }
    // Same guard the extension needed: this banner doubles as the PRE-OPEN placeholder, so it is only
    // terminal once we have actually seen the form open in this session.
    if (st.closed && formSeen) { log('FULL — capacity reached, stopping'); emitStatus('closed', 'capacity reached'); break; }

    // Cloudflare BEFORE blank — an interstitial has no text and no controls, so the blank branch
    // would match it and reload, restarting the challenge every time so it could never pass.
    if (st.challenge && !st.hasToken) {
      // An INVISIBLE pending Turnstile is not necessarily a block. On a campaign that is not live
      // yet, ShortStack renders nothing and the widget simply never resolves — which is exactly what
      // a page being camped before go-live looks like. Since waiting for go-live is the entire job,
      // this state must keep watching for the full giveUpHours, not give up on it.
      //
      // A VISIBLE widget or a full-page interstitial is different: those are served TO US, and if
      // one has not cleared in five minutes this IP is not going to clear it.
      const blocking = st.challengeKind !== 'invisible Turnstile (form will not render until it passes)';
      if (!challengeWarned) {
        challengeWarned = true;
        challengeSince = Date.now();
        log('security check in progress — waiting it out (a reload would restart it)');
        vlog(`  ${st.challengeKind}${blocking ? ' · blocking' : ''}`);
        emitStatus(blocking ? 'challenge' : 'watching', st.challengeKind);
        emitCf('solving', st.challengeKind);
      }
      // A token normally arrives in a few seconds — measured ~3s on an IP Cloudflare trusts, against
      // this same dormant page. So an invisible Turnstile still unresolved after 25s is not "the
      // campaign has not opened", it is this IP being held. Say so, and mark CF failed so the chip
      // reflects reality; keep watching rather than killing the task, because Turnstile is scored
      // per request and a later attempt can still pass.
      if (!blocking && !cfHeldReported && Date.now() - challengeSince > 25000) {
        cfHeldReported = true;
        log(`⛔ still not verified after 25s — ${PROXY_RAW ? 'this proxy looks blocked.' : 'your home IP looks blocked.'}`);
        vlog('   a trusted IP passes in ~3s, so this is the IP, not the bot');
        emitCf('failed', PROXY_RAW ? 'IP held — rotate the proxy' : 'home IP held');
      }
      if (blocking && Date.now() - challengeSince > 5 * 60 * 1000) {
        log('not getting through after 5 minutes — stopping.');
        emitStatus('challenge', 'not cleared in 5 min — rotate this proxy');
        emitCf('failed', 'not cleared in 5 min');
        break;
      }
      // Re-navigating would restart the challenge, so this only re-inspects the same document.
      await sleep(blocking ? 2000 : 5000);
      continue;
    }
    if (challengeWarned) {
      challengeWarned = false;
      cfHeldReported = false;
      log('verified — watching for the form');
    }
    // The page rendering IS the proof the token was issued: ShortStack builds nothing until then.
    if (!st.challenge && !st.blank) emitCf('solved', st.hasToken ? 'token issued' : 'page rendered');

    if (st.blank) {
      // Escalating backoff. The old version reloaded immediately on every pass, so a proxy that
      // errors on goto() produced a reload a second — the loudest possible signal to an antibot,
      // and it never said why. Report what the page actually was so a dead proxy, a challenge we
      // do not recognise, and a genuinely empty render are distinguishable.
      blankStreak++;
      const wait = Math.min(30000, 2000 * blankStreak);
      // mounted === 0 with a real title is the SPA not having run, which is worth naming: it means
      // the page arrived and its scripts did not finish, not that the site is down or blocking us.
      const why = st.mounted === 0 ? 'page arrived but its JavaScript never built the form'
        : st.mounted < 0 ? 'not a ShortStack campaign page (no tw_container)'
        : 'rendered nothing';
      log(`page did not load (${blankStreak}) — retrying in ${Math.round(wait / 1000)}s`);
      vlog(`  ${why} · title="${st.title}" text=${st.textLen}${lastNavError ? ` · nav error: ${lastNavError}` : ''}`);
      emitStatus('watching', `blank page ×${blankStreak}`);
      if (blankStreak >= 8) {
        log('⛔ page never loaded after eight tries — check the proxy or the campaign link. Stopping.');
        emitStatus('error', lastNavError ? `proxy/nav failure: ${lastNavError}` : 'page never rendered');
        emitCf('unknown', 'page never rendered — cannot tell');
        break;
      }
      await sleep(wait);
      await goto().catch(() => {});
      continue;
    }
    blankStreak = 0;

    if (st.formReady && !st.closed) {
      formSeen = true;
      if (attempts >= MAX_ATTEMPTS) {
        log(`stopping after ${MAX_ATTEMPTS} attempts without a clear result — not risking a duplicate entry`);
        emitStatus('maxattempts', `${MAX_ATTEMPTS} attempts, no clear result`);
        break;
      }
      const r = await fillAndSubmit(page, human, st).catch((e) => {
        if (isDeadBrowser(e, page)) throw e;
        log('  attempt failed before submitting — retrying');
      vlog(`  ${e.message}`);
        return { clicked: false, outcome: 'error' };
      });
      if (r.clicked) attempts++;
      if (r.outcome === 'success') { log('✅ registered' + (entryId ? ' · entry ' + entryId : '') + (fillStartedAt ? ' · form-to-submit ' + ((Date.now() - fillStartedAt) / 1000).toFixed(1) + 's' : '')); emitStatus('success', entryId ? PROFILE.email + ' · entry ' + entryId : PROFILE.email); break; }
      if (r.outcome === 'soldout') { emitStatus('soldout', ''); break; }
      // A re-render is the site struggling, not a rejected entry, so it must not count against the
      // three-attempt cap — otherwise a laggy drop exhausts the budget without ever being seen.
      if (r.outcome === 'form-rerendered') { if (r.clicked) attempts--; log('  retrying after the re-render'); await sleep(800); continue; }
      await sleep(1500);
      await goto().catch(() => {});
      continue;
    }

    // @@STATUS goes to the task board, not the log, so on its own the log showed a reload every 20s
    // with no verdict — indistinguishable from being stuck. Say it in the log too: once on entry, on
    // any change, and then every tenth cycle so a long camp shows progress without scrolling away.
    const watchState = st.closed ? 'form closed — waiting for it to open' : 'form not open yet';
    watchCycles++;
    // Only claim Cloudflare cleared if the page ACTUALLY LOADED. After a failed navigation the tab is
    // still on about:blank, which has no challenge markers and no form — so the ladder fell through
    // to here and reported success on a page that never arrived. That is a false positive on the one
    // line being used to judge whether a proxy is usable, which makes it worse than no line at all.
    if (lastNavError) {
      log('⚠ the page never loaded');
      vlog(`  ${lastNavError}`);
      emitCf('unknown', 'page never loaded');
      emitStatus('error', `nav failed: ${lastNavError.slice(0, 70)}`);
      await sleep(3000);
      await goto().catch(() => {});
      continue;
    }
    if (watchState !== lastWatchState || watchCycles % 10 === 1) {
      log(`✓ page loaded — ${watchState}${watchCycles > 1 ? ` · checked ${watchCycles}×` : ''}`);
    }
    lastWatchState = watchState;
    emitStatus('watching', watchState);
    const until = Date.now() + RELOAD_MS * (0.85 + Math.random() * 0.3);  // jitter so parallel tasks do not reload in lockstep
    while (Date.now() < until) {
      await sleep(DOM_POLL_MS);
      const s2 = await page.evaluate(inspectAndTagPage).catch(() => null);
      if (s2 && ((s2.formReady && !s2.closed) || s2.success || s2.blank || (s2.challenge && !s2.hasToken))) break;
    }
    await goto().catch(() => {});
  }

  if (Date.now() >= deadline) { log('gave up — the form never opened'); emitStatus('error', 'gave up without the form opening'); }
  try { context.__intentional = true; await browser.close(); } catch {}
  if (mock) mock.close();
  process.exit(0);
}

// Used by the first fill AND by the mid-submit refill, so the two can never drift apart — a refill
// that set different values from the original would be worse than not refilling at all.
async function refill(page, human, st) {
  const typeInto = async (sel, value) => {
    if (HUMAN_FILL) { if (await human.type(sel, value).catch(() => false)) return; }
    await page.fill(sel, value).catch(() => {});
  };
  await typeInto('[data-r1="first"]', PROFILE.first);
  await typeInto('[data-r1="last"]', PROFILE.last);
  await typeInto('[data-r1="email"]', PROFILE.email);
  if (st.tagged.email2) await page.fill('[data-r1="email2"]', PROFILE.email).catch(() => {});
  const idx = findStoreIndex(st.storeOptions, PROFILE.store);
  if (idx >= 0) await page.locator('[data-r1="store"]').selectOption({ index: idx }).catch(() => {});
  await page.locator('[data-r1="terms"]').check().catch(() => {});
  if (PROFILE.marketing && st.tagged.news) await page.locator('[data-r1="news"]').check().catch(() => {});
  return idx;
}

async function fillAndSubmit(page, human, st) {
  // Start the fill clock HERE, not only at the test-mode stage-2 handoff.
  //
  // fillStartedAt was set in exactly one place -- the transition from the live campaign to the local
  // form during a `test` run -- so `mock` runs, and real drops, printed "registered" with no timing
  // at all. The number is most useful precisely on a real run, which was the one case it never
  // appeared. Guarded so test mode keeps measuring from its own stage-2 start rather than restarting
  // the clock here.
  if (!fillStartedAt) fillStartedAt = Date.now();
  log('form open — filling');
  emitStatus('filling', PROFILE.store);

  const idx = findStoreIndex(st.storeOptions, PROFILE.store);
  if (idx < 0) {
    log(`store "${PROFILE.store}" is not in the list — check the spelling in this profile.`);
    vlog(`  offered: ${(st.storeOptions || []).slice(0, 6).join(' | ')}`);
    emitStatus('error', `store "${PROFILE.store}" not offered`);
    return { clicked: false, outcome: 'error' };
  }

  // human.type/click move along a curved path and type with variable rhythm. Turnstile scores
  // behaviour, and a form filled in 40ms by a teleporting cursor is the cheapest possible tell.
  const typeInto = async (sel, value) => {
    if (HUMAN_FILL) { if (await human.type(sel, value).catch(() => false)) return; }
    await page.fill(sel, value).catch(() => {});
  };
  await typeInto('[data-r1="first"]', PROFILE.first);
  await typeInto('[data-r1="last"]', PROFILE.last);
  await typeInto('[data-r1="email"]', PROFILE.email);
  if (st.tagged.email2) await page.fill('[data-r1="email2"]', PROFILE.email).catch(() => {});
  await page.locator('[data-r1="store"]').selectOption({ index: idx });
  log(`store: ${String(st.storeOptions[idx]).replace(/\s+/g, ' ').trim()}`);
  await page.locator('[data-r1="terms"]').check().catch(() => {});
  if (PROFILE.marketing && st.tagged.news) await page.locator('[data-r1="news"]').check().catch(() => {});

  const before = await page.evaluate(() => document.body.innerText).catch(() => '');
  const endAt = Date.now() + SUBMIT_WINDOW_MS;
  let clicked = false;
  emitStatus('submitting', '');

  while (Date.now() < endAt) {
    // Cloudflare FIRST. While a widget is pending with no token, clicking ENTER just RESETS it —
    // so a re-click loop would keep the challenge permanently un-passed. Wait it out instead.
    const ch = await page.evaluate(() => {
      const vis = (el) => { const r = el.getBoundingClientRect(); if (r.width === 0 && r.height === 0) return false; const s = getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none'; };
      const visible = [...document.querySelectorAll('iframe')].some((f) => /challenges\.cloudflare\.com|recaptcha|hcaptcha/i.test(f.src || '') && vis(f));
      const tok = document.querySelector('input[name="cf-turnstile-response"], input[name*="turnstile-response"], textarea[name*="turnstile"], [name="g-recaptcha-response"]');
      return { visible, hasToken: !!(tok && tok.value) };
    }).catch((e) => { if (isDeadBrowser(e, page)) throw e; return { visible: false, hasToken: false }; });

    if (ch.visible && !ch.hasToken) { await sleep(1200); continue; }

    // Re-verify before EVERY click. A validation re-render — which is exactly what a site under load
    // produces — can clear the store select or the T&C box while leaving the email looking fine, and
    // re-clicking an incomplete form spends one of only three attempts on a guaranteed rejection.
    // The extension learned this the hard way (content.js fieldsNeedRefill); the port had dropped it.
    const wiped = await page.evaluate(() => {
      const q = (n) => document.querySelector(`[data-r1="${n}"]`);
      const missing = [];
      for (const n of ['first', 'last', 'email']) { const el = q(n); if (!el) return ['retag']; if (!el.value.trim()) missing.push(n); }
      const store = q('store');
      if (!store) return ['retag'];
      if (!store.value || store.selectedIndex <= 0) missing.push('store');
      const terms = q('terms');
      if (!terms) return ['retag'];
      if (!terms.checked) missing.push('terms');
      return missing;
    }).catch(() => []);

    if (wiped.length) {
      if (wiped[0] === 'retag') {
        // The form was re-rendered wholesale, so the data-r1 tags point at dead nodes. Re-tagging is
        // the caller's job; bail out and let the main loop re-inspect rather than click blind.
        vlog('  the form was re-rendered mid-submit — re-inspecting rather than clicking a stale page');
        return { clicked, outcome: 'form-rerendered' };
      }
      log('  the form reset itself — refilling');
      vlog(`  cleared: ${wiped.join(', ')}`);
      const st2 = await page.evaluate(inspectAndTagPage).catch(() => null);
      if (st2 && st2.formReady) { await refill(page, human, st2); } else { return { clicked, outcome: 'form-rerendered' }; }
    }

    if (!HUMAN_FILL || !(await human.click('[data-r1="submit"]').catch(() => false))) {
      await page.click('[data-r1="submit"]', { timeout: 4000 }).catch(() => {});
    }
    clicked = true;
    await sleep(RECLICK_MS);

    const now = await page.evaluate(() => document.body.innerText).catch(() => '');
    if (/successfully registered|successfully reserved|thank you for (registering|your registration)/i.test(now)) return { clicked, outcome: 'success' };
    if (/we have run out of/i.test(now)) return { clicked, outcome: 'soldout' };
    if (now && before && now !== before) {
      const stillOpen = await page.evaluate(inspectAndTagPage).catch(() => null);
      if (stillOpen && !stillOpen.formReady) return { clicked, outcome: 'form-gone' };
    }
  }
  return { clicked, outcome: 'timeout' };
}

main().catch((e) => { log(`FATAL: ${e.message}`); emitStatus('error', String(e.message).slice(0, 120)); process.exit(1); });
