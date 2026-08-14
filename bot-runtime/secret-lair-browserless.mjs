// secret-lair-browserless.mjs
// Fully headless (no visible windows). Paste URL → done.
// Browser is invisible Chromium. Queue-it handled natively by Angular.

import { readFileSync, existsSync, mkdirSync, appendFileSync, writeFileSync } from 'fs';
import { URLSearchParams, fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { ProxyAgent } from 'undici';
import { chromium } from 'playwright';
import path from 'path';

// ─── Colors ───────────────────────────────────────────────────────────────────
const C = {
  r:    '\x1b[0m',
  dim:  '\x1b[2m',
  bold: '\x1b[1m',
  y:    '\x1b[33m',   // yellow  — adding/in-progress
  g:    '\x1b[32m',   // green   — success
  rd:   '\x1b[31m',   // red     — error/decline
  cy:   '\x1b[36m',   // cyan    — step headers
  bg:   '\x1b[92m',   // bright green — confirmed
  br:   '\x1b[91m',   // bright red   — declined
  bw:   '\x1b[97m',   // bright white — totals
};
// Each thread gets a distinct color for its prefix
const _TCOLORS = ['\x1b[96m','\x1b[95m','\x1b[93m','\x1b[92m','\x1b[34m','\x1b[91m','\x1b[97m','\x1b[90m'];
const _TC = _TCOLORS[(parseInt(process.argv[3]||'1')-1) % _TCOLORS.length];

// ─── Logger ───────────────────────────────────────────────────────────────────
// fileURLToPath rather than a hand-rolled drive-letter strip: the old version also left %20 in place
// of spaces, so any install path containing one produced a directory that could never be written.
const LOGS_DIR = fileURLToPath(new URL('../logs', import.meta.url));
const PROFILES_DIR = fileURLToPath(new URL('../profiles', import.meta.url));
mkdirSync(LOGS_DIR,     { recursive:true });
mkdirSync(PROFILES_DIR, { recursive:true });

const _TID    = process.argv[3] ? `-t${process.argv[3]}` : '';
const RUN_TS  = new Date().toISOString().replace(/[:.]/g,'-').slice(0,23) + _TID;
const LOG_FILE = path.join(LOGS_DIR, `run-${RUN_TS}.txt`);

function ts() { return new Date().toISOString().slice(11,23); }

const _TPFX   = process.argv[3] ? `[T${process.argv[3]}] ` : '';
const _TPFX_C = process.argv[3] ? `${_TC}[T${process.argv[3]}]${C.r} ` : '';

function _autoColor(line) {
  // Errors — red
  if (/page regressed|WARNING|FAIL|failed|could not|unreachable|error:/i.test(line)) return C.rd;
  // Declines — bright red
  if (/declined|refused|payment.*declined/i.test(line))                              return C.br;
  // Confirmed — bright green
  if (/ORDER CONFIRMED/i.test(line))                                                 return C.bg;
  // Step headers — cyan
  if (/^\s*\[\d+\]/.test(line))                                                      return C.cy;
  // Timing lines — dim
  if (/\[step \d+:/i.test(line))                                                     return C.dim;
  if (/screenshot saved|log file:|cart url:|proxy:|angular cart|  route:/i.test(line)) return C.dim;
  // Checkout progress — green
  if (/queue-it validated|cart api.*ok|✓ /i.test(line))                             return C.g;
  // Totals — bright white
  if (/order total:/i.test(line))                                                    return C.bw;
  // Adding items & clicking — yellow
  if (/qty set to|add-to-cart|clicked:|continue clicked|fields filled|add to cart/i.test(line)) return C.y;
  return '';
}
function log(...args) {
  const line = args.join(' ');
  const col  = _autoColor(line);
  console.log(`${_TPFX_C}${col}${line}${col ? C.r : ''}`);
  appendFileSync(LOG_FILE, `[${ts()}] ${line}\n`);
}
function logErr(...args) {
  const line = args.join(' ');
  console.error(`${_TPFX_C}${C.br}ERROR: ${line}${C.r}`);
  appendFileSync(LOG_FILE, `[${ts()}] ERROR: ${line}\n`);
}

async function screenshot(page, label) {
  try {
    const name = `${RUN_TS}-${label.replace(/\W+/g,'-')}.png`;
    const file = path.join(LOGS_DIR, name);
    await page.screenshot({ path:file }); // viewport only — fullPage is slow
    log(`  screenshot saved: ${path.join('logs', name)}`);
  } catch {}
}

// ─── Discord Webhook ─────────────────────────────────────────────────────────
const WEBHOOK_URL = '';

async function sendWebhook({ success, product, qty, total, email, webhook }) {
  const webhookUrl = String(webhook || WEBHOOK_URL).trim();
  if (!/^https:\/\/(?:discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/.test(webhookUrl)) return;
  try {
    const color  = success ? 0x57F287 : 0xED4245;
    const title  = success ? '✅  Checked Out!' : '❌  Payment Declined';
    const thread = process.argv[3] ? `T${process.argv[3]}` : 'T1';
    await fetch(webhookUrl, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({
        username: 'Zyn',
        avatar_url: 'https://zynbot.app/zyn-icon.png',
        embeds: [{
          title,
          color,
          fields: [
            { name: 'Product', value: product || 'Secret Lair',  inline: false },
            { name: 'Qty',     value: String(qty || 1),          inline: true  },
            { name: 'Total',   value: total   || 'Unknown',      inline: true  },
            { name: 'Email',   value: email   || '—',            inline: true  },
            { name: 'Thread',  value: thread,                    inline: true  },
          ],
          timestamp: new Date().toISOString(),
          footer: { text: 'Zyn', icon_url: 'https://zynbot.app/zyn-icon.png' },
        }],
      }),
    });
  } catch (e) {
    logErr(`webhook failed: ${e.message}`);
  }
}

// ─── Manual Fallback ─────────────────────────────────────────────────────────
async function launchManualFallback(page, url, proxy = null) {
  try {
    const cookies    = await page.context().cookies();
    const cookieFile = path.join(LOGS_DIR, `manual-${RUN_TS}.json`);
    writeFileSync(cookieFile, JSON.stringify(cookies));

    // fileURLToPath does what the drive-letter strip and separator swap were hand-rolling, and does
    // it correctly on both platforms — on macOS the pathname is already absolute and the old
    // forward-slash-to-backslash pass would have mangled it into a single unusable filename.
    const fallbackScript = fileURLToPath(new URL('./manual-fallback.mjs', import.meta.url));
    const tid = process.argv[3] || '1';
    // Pass proxy as JSON so the headed browser uses the same IP that owns this session
    const proxyArg = proxy
      ? JSON.stringify({ server: proxy.server, username: proxy.username || '', password: proxy.password || '' })
      : '';

    // Use process.execPath (absolute path to node.exe) — 'node' may not resolve in PATH
    // when running as a piped child process on Windows
    const child = spawn(process.execPath, [fallbackScript, cookieFile, url, tid, proxyArg], {
      detached: true,
      stdio   : 'ignore',
    });
    child.unref();
    log(`  [MANUAL] Headed browser launched — complete checkout in the popup window`);
  } catch (e) {
    logErr(`launchManualFallback: ${e.message}`);
  }
}

async function dumpPage(page, label) {
  try {
    const url  = page.url();
    const text = await page.evaluate(()=>document.body?.innerText?.slice(0,800)||'').catch(()=>'');
    log(`  [${label}] url: ${url}`);
    log(`  [${label}] page: ${text.replace(/\n+/g,' ').trim().slice(0,300)}`);
  } catch {}
}

// ─── Constants ────────────────────────────────────────────────────────────────
const SF = {
  userId:        10751401,
  flashId:       '7',
  productId:     '1252561',
  license:       5,
  profilingToken:'d5bdd4cd2baa14a8aecde098974eefcd',
  optinsToken:   '5920870687787c496453bb8625429dc6',
};
// The drop identity above can be overridden per drop via config.drop, so a new Secret Lair drop
// needs no code edit. IMPORTANT: userId is the STORE's Scalefast MERCHANT id — every shopper shares
// it (the profiling call registers the shopper's PII *under* this merchant). It is NOT a per-shopper
// identity; per-shopper identity = email + saved cookies + card + queue pass + proxy (all per-task).
function applyDropConfig(config) {
  const d = config && config.drop;
  if (!d) return;
  for (const k of ['userId', 'flashId', 'productId', 'license', 'profilingToken', 'optinsToken']) {
    if (d[k] !== undefined && d[k] !== null && d[k] !== '') SF[k] = d[k];
  }
}
const UA     = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const ORIGIN = 'https://secretlair.wizards.com';

const STATE_CODES = {
  Alabama:'AL',Alaska:'AK',Arizona:'AZ',Arkansas:'AR',California:'CA',Colorado:'CO',
  Connecticut:'CT',Delaware:'DE',Florida:'FL',Georgia:'GA',Hawaii:'HI',Idaho:'ID',
  Illinois:'IL',Indiana:'IN',Iowa:'IA',Kansas:'KS',Kentucky:'KY',Louisiana:'LA',
  Maine:'ME',Maryland:'MD',Massachusetts:'MA',Michigan:'MI',Minnesota:'MN',
  Mississippi:'MS',Missouri:'MO',Montana:'MT',Nebraska:'NE',Nevada:'NV',
  'New Hampshire':'NH','New Jersey':'NJ','New Mexico':'NM','New York':'NY',
  'North Carolina':'NC','North Dakota':'ND',Ohio:'OH',Oklahoma:'OK',Oregon:'OR',
  Pennsylvania:'PA','Rhode Island':'RI','South Carolina':'SC','South Dakota':'SD',
  Tennessee:'TN',Texas:'TX',Utah:'UT',Vermont:'VT',Virginia:'VA',Washington:'WA',
  'West Virginia':'WV',Wisconsin:'WI',Wyoming:'WY',
};
function toStateCode(s) {
  if (/^[A-Z]{2}$/.test(s)) return s;
  return STATE_CODES[s] ?? s.slice(0,2).toUpperCase();
}
function toStateName(codeOrName) {
  const code = toStateCode(codeOrName);
  return Object.keys(STATE_CODES).find(k => STATE_CODES[k] === code) ?? codeOrName;
}

// ─── Proxies ──────────────────────────────────────────────────────────────────
// Accepts the shapes providers actually hand out:
//   host:port                 host:port:user:pass                 user:pass@host:port
// The password is EVERYTHING after the third colon, not one field. A bare split(':') truncated any
// password containing ':' — and a truncated password is indistinguishable from no password at all:
// the proxy answers 407 and it looks like a dead proxy rather than a parsing bug.
function parseProxyLine(l) {
  if (!l) return null;
  const s = String(l).trim().replace(/^https?:\/\//i, '');
  if (!s) return null;

  let ip, port, user, pass;
  if (s.includes('@')) {
    const at = s.lastIndexOf('@');
    const creds = s.slice(0, at);
    const hostPort = s.slice(at + 1).split(':');
    const c = creds.indexOf(':');
    [ip, port] = hostPort;
    user = c >= 0 ? creds.slice(0, c) : creds;
    pass = c >= 0 ? creds.slice(c + 1) : '';
  } else {
    const parts = s.split(':');
    [ip, port] = parts;
    user = parts[2] || '';
    pass = parts.slice(3).join(':');   // keep colons that belong to the password
  }
  if (!ip || !port) return null;
  return { server:`http://${ip}:${port}`, username:user || undefined, password:pass || undefined, ip, hasAuth: !!user };
}
function loadProxies() {
  // Per-task pool via --proxies=<path> (isolated so parallel tasks don't clobber one shared file);
  // falls back to the engine-local proxies.txt for bare CLI runs.
  const cliPath = (process.argv.find(a => a.startsWith('--proxies=')) || '').slice('--proxies='.length);
  const p = cliPath || new URL('./proxies.txt', import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1');
  if (!existsSync(p)) return [];
  return readFileSync(p,'utf8').split('\n').map(l=>l.trim()).filter(Boolean).map(parseProxyLine).filter(Boolean);
}
const PROXIES = loadProxies();
// Paired proxy from the queue pass (--proxy=ip:port:user:pass). The Queue-It token is bound to
// the IP that cleared the queue, so checkout MUST use that exact proxy — it overrides the pool.
const CLI_PROXY = parseProxyLine((process.argv.find(a => a.startsWith('--proxy=')) || '').slice('--proxy='.length));
// Last few picks, so a rotation never lands straight back on an IP this process just used —
// reusing an exit IP within a few minutes is what gets it flagged.
const recentProxies = [];
function nextProxy() {
  if (CLI_PROXY) return CLI_PROXY;  // paired proxy always wins
  if (!PROXIES.length) return null;
  // Random, not a walk. The old version stepped through the pool from a per-run offset, so threads
  // moved through it in lockstep and every run covered only a tiny prefix of a large shared list.
  const limit = Math.min(50, Math.max(0, PROXIES.length - 1));
  let idx = 0;
  for (let attempt = 0; attempt < 40; attempt++) {
    idx = Math.floor(Math.random() * PROXIES.length);
    if (!recentProxies.includes(idx)) break;
  }
  recentProxies.push(idx);
  while (recentProxies.length > limit) recentProxies.shift();
  return PROXIES[idx];
}

// ─── HTTP helper (profiling/optins background calls) ──────────────────────────
async function sfFetch(url, opts) {
  return fetch(url, {
    ...opts,
    headers: { Origin:ORIGIN, Referer:`${ORIGIN}/`, 'User-Agent':UA, DNT:'1', ...opts.headers },
  });
}
async function postProfiling(profile, qty) {
  const nc = `${SF.productId}:${SF.license}:0:${qty}:::USDUS;`;
  const body = new URLSearchParams({ request_data: JSON.stringify({
    keyID:Date.now(), lang:'EN', ncart:nc, ocart:nc, trackID:'0',
    infos:{
      title:'Mr', firstname:profile.firstName, lastname:profile.lastName,
      email:profile.email,
      address:profile.address2 ? `${profile.address1} ${profile.address2}` : profile.address1,
      zipcode:profile.zip, city:profile.city,
      state:`US-${toStateCode(profile.state)}`, country:'US',
      phone:profile.phone, type:'individual',
    },
    url:`${ORIGIN}/us/cart`, currency:'USD', appID:SF.flashId,
  })});
  await sfFetch(`https://api.scalefast.com/profiling/${SF.userId}/customer`, {
    method:'POST',
    headers:{ 'Content-Type':'application/x-www-form-urlencoded','access-token':SF.profilingToken },
    body:body.toString(),
  }).catch(()=>{});
}
async function postOptins(profile) {
  const body = new URLSearchParams({
    request_data:JSON.stringify({
      email:profile.email, host:`${ORIGIN}/us/cart#/cart`,
      flashID:SF.flashId, air360_deviceID:'', provider:'log', subscribeMarketingIfNull:true,
    }),
    _method:'POST', access_token:SF.optinsToken, 'API-Version':'v10',
  });
  await sfFetch('https://eu-api.scalefast.com/optins', {
    method:'POST',
    headers:{ 'Content-type':'application/x-www-form-urlencoded; charset=utf-8' },
    body:body.toString(),
  }).catch(()=>{});
}

// ─── Angular-aware field fill ─────────────────────────────────────────────────
async function ngFill(page, selectors, value) {
  for (const sel of (Array.isArray(selectors)?selectors:[selectors])) {
    const el = await page.$(sel).catch(()=>null);
    if (!el) continue;
    await el.scrollIntoViewIfNeeded().catch(()=>{});
    await el.click({ clickCount:3 }).catch(()=>{});
    await el.fill(value).catch(()=>{});
    // Trigger Angular digest
    await page.evaluate(s => {
      const el = document.querySelector(s);
      if (!el) return;
      ['input','change','blur'].forEach(e=>el.dispatchEvent(new Event(e,{bubbles:true})));
      try {
        const ng = window.angular?.element(el);
        ng?.triggerHandler('input');
        ng?.triggerHandler('change');
        const sc = ng?.scope() ?? ng?.controller();
        if (sc && !sc.$$phase) sc.$apply();
      } catch {}
    }, sel).catch(()=>{});
    return true;
  }
  return false;
}
async function ngSelect(page, sel, value) {
  const el = await page.$(sel).catch(()=>null);
  if (!el) return false;
  // Use short timeout so a missing option doesn't hang for 30s
  const T = { timeout:2000 };
  const ok = await page.selectOption(sel, { value }, T).catch(()=>null)
          ?? await page.selectOption(sel, { label:value }, T).catch(()=>null);
  if (!ok) return false;
  await page.evaluate(s => {
    const el = document.querySelector(s);
    if (!el) return;
    try {
      const ng = window.angular?.element(el);
      ng?.triggerHandler('change');
      const sc = ng?.scope() ?? ng?.controller();
      if (sc && !sc.$$phase) sc.$apply();
    } catch {}
  }, sel).catch(()=>{});
  return true;
}

// ─── Adyen card fill ──────────────────────────────────────────────────────────
// Adyen SecuredFields listens for keyboard events at the iframe's document level,
// NOT on the input element. Strategy: click the <iframe> from the parent page to
// focus it, then use page.keyboard.type() which sends to the focused frame's document.
async function fillAdyenCard(page, card) {
  const adyenFrames = page.frames().filter(f => f.url().includes('checkoutshopper-live.adyen.com'));
  appendFileSync(LOG_FILE, `[${ts()}]   adyen frames: ${adyenFrames.length}\n`);

  async function typeIntoIframe(title, fallbackFrameIdx, value, label) {
    // Primary: click the <iframe> element in the parent → focuses Adyen's document listener
    const clickedParent = await page.evaluate((t) => {
      const el = document.querySelector(`iframe[title="${t}"]`)
              ?? [...document.querySelectorAll('iframe[src*="checkoutshopper"]')][t];
      if (el) { el.scrollIntoView({ behavior:'instant', block:'center' }); return true; }
      return false;
    }, title).catch(()=>false);

    if (clickedParent) {
      try {
        await page.click(`iframe[title="${title}"]`, { timeout:5000 });
        await page.waitForTimeout(80);
        await page.keyboard.type(value, { delay:30 });
        log(`    ✓ ${label}`);
        return;
      } catch(e) {
        appendFileSync(LOG_FILE, `[${ts()}]     parent click failed (${label}): ${e.message.slice(0,60)}\n`);
      }
    }

    // Fallback: focus the input inside the adyen frame, then keyboard.type from page
    const frame = adyenFrames[fallbackFrameIdx];
    if (!frame) { logErr(`    no frame for ${label}`); return; }
    try {
      const input = frame.locator('input').first();
      await input.waitFor({ timeout:5000 });
      await input.focus({ timeout:3000 });
      await page.waitForTimeout(80);
      await page.keyboard.type(value, { delay:30 });
      log(`    ✓ ${label} (frame fallback)`);
    } catch(e) {
      logErr(`    could not fill ${label}: ${e.message.slice(0,80)}`);
    }
  }

  // NOTE: do NOT try to verify these by reading input.value inside the iframe. Adyen's SecuredFields
  // intercept keystrokes and hold the value internally (encrypted), so the input reports EMPTY even
  // when the field is visibly filled. A previous attempt at a verify-and-retype pass read every
  // field as empty and retyped all three on top of good input. If verification is wanted, read
  // Adyen's own validity state on the PARENT page (its field wrappers get valid/error classes),
  // never the raw input value.
  await typeIntoIframe('Iframe for card number',   0, card.number, 'card number');
  await page.waitForTimeout(50);
  await typeIntoIframe('Iframe for expiry date',   1, card.expiry, 'expiry');
  await page.waitForTimeout(50);
  await typeIntoIframe('Iframe for security code', 2, card.cvv,    'CVV');

}

// ─── Cookie persistence (builds browser trust across runs) ───────────────────
function cookiePath(email) {
  return path.join(PROFILES_DIR, email.replace(/[^a-zA-Z0-9]/g, '_') + '.json');
}
function loadSavedCookies(email) {
  try {
    const p = cookiePath(email);
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  } catch {}
  return null;
}
async function saveCookies(email, context) {
  try {
    const cookies = await context.cookies();
    if (cookies.length) writeFileSync(cookiePath(email), JSON.stringify(cookies, null, 2));
  } catch {}
}

// Cookie-consent and newsletter/marketing overlays sit ON TOP of the cart and swallow a
// coordinate-based click, so Secure Checkout never advances the page. Dismiss them (accept cookies,
// decline the newsletter, close any visible modal) so the real click lands on the button.
async function dismissOverlays(page) {
  await page.evaluate(() => {
    const vis = el => !!(el && el.offsetParent !== null);
    const clickByText = (re) => {
      for (const b of document.querySelectorAll('button, a, [role="button"]')) {
        if (vis(b) && re.test((b.textContent || '').trim())) { try { b.click(); } catch {} return true; }
      }
      return false;
    };
    clickByText(/^(accept all cookies|accept all|accept cookies|allow all|i accept|agree|got it)$/i);
    clickByText(/^(no,? keep me here|no thanks|not now|maybe later|dismiss|decline)$/i);
    // Close any visible marketing/newsletter dialog via its own close control
    for (const dlg of document.querySelectorAll('[class*="modal" i],[class*="popup" i],[class*="newsletter" i],[role="dialog"]')) {
      if (!vis(dlg)) continue;
      const x = dlg.querySelector('[aria-label*="close" i],button.close,.close,[class*="close" i]');
      if (vis(x)) { try { x.click(); } catch {} }
    }
  }).catch(() => {});
}

// Proxies (especially token-bound queue-pass proxies near end of life) can blip: a single 407 or
// tunnel error kills a nav. Retry a few times so a transient blip doesn't waste the whole run.
async function gotoWithRetry(page, url, label, timeout = 30000, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
      if (r && r.status() === 407) throw new Error('proxy 407');
      return r;
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) {
        log(`  [${label}] nav failed (${(e.message || '').split('\n')[0].slice(0, 48)}) — retry ${i + 2}/${tries}`);
        await page.waitForTimeout(1500);
      }
    }
  }
  throw lastErr || new Error(`goto ${label} failed`);
}

// ─── Main checkout flow ───────────────────────────────────────────────────────
export async function runBrowserlessCheckout(cartUrl, profile, config, qty=1) {
  applyDropConfig(config);  // merge per-drop overrides into SF before profiling/optins fire
  const proxy = nextProxy();
  // Report whether credentials were parsed. A 407 looks identical whether the proxy is dead or we
  // simply sent no auth, so without this the two are impossible to tell apart from the log.
  // Port and password LENGTH (never the password) are included because a 407 with credentials
  // present has only two explanations: the value we parsed is corrupt, or the proxy is genuinely
  // refusing it. A wrong port or an unexpected password length identifies the first immediately;
  // if both look right, the problem is on the provider's side, not in parsing.
  // Credentials are masked: logs get pasted into chats and issue reports. The first two characters
  // are enough to tell two accounts apart, and the password LENGTH is what actually diagnoses a
  // mangled capture (a 14-char password where the account's is 12), so neither is printed in full.
  const maskUser = (u) => !u ? '' : (u.length <= 2 ? '*'.repeat(u.length) : u.slice(0, 2) + '*'.repeat(u.length - 2));
  if (proxy) log(`  proxy: ${proxy.server.replace('http://', '')}${CLI_PROXY ? ' (paired with queue pass)' : ' (from pool)'}` +
    (proxy.hasAuth ? ` · auth: ${maskUser(proxy.username)} (pass ${(proxy.password || '').length} chars)` : ' · auth: NONE PARSED'));

  // "No queue" mode: if cartUrl is '--no-queue' or missing qitq= params, skip step 1
  const hasQueueUrl = cartUrl && cartUrl.includes('qitq=');

  log(`  log file: ${path.join("logs", `run-${RUN_TS}.txt`)}`);
  if (hasQueueUrl) log(`  cart url: ${cartUrl.slice(0,80)}...`);
  else             log(`  mode: direct checkout (no Queue-It URL — skipping step 1)`);

  const HEADED = process.argv.includes('--headed');
  const proxyOpts = proxy
    ? { server: proxy.server, username: proxy.username || undefined, password: proxy.password || undefined }
    : undefined;
  const browser = await chromium.launch({
    headless: !HEADED,
    // Playwright >=1.49 runs headless via a SEPARATE "chromium_headless_shell" binary, which the
    // installer does not bundle — only the full chromium build. Headed runs therefore worked while
    // every headless run died with "Executable doesn't exist at ...chromium_headless_shell-1228".
    // channel:'chromium' pins it to the full browser we actually ship, in headless mode, rather
    // than adding another ~100 MB of shell to the installer.
    channel: 'chromium',
    slowMo: HEADED ? 300 : 0,
    // Chromium needs a proxy set at LAUNCH for an authenticated per-context proxy to work — without it,
    // credentials passed only to newContext are ignored and the proxy returns HTTP 407. Each task is
    // its own browser with one paired proxy, so we launch directly with it.
    proxy: proxyOpts,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-features=AutomationControlled',
      '--no-sandbox',
      '--disable-infobars',
      '--disable-dev-shm-usage',
      '--disable-notifications',
      '--disable-popup-blocking',
      '--lang=en-US,en',
      '--window-size=1280,900',
      '--use-gl=angle',            // real ANGLE renderer instead of SwiftShader bot signal
      ...(HEADED ? ['--start-maximized'] : []),
    ],
  });
  // HAR recording: capture ALL network traffic so we can inspect which API response
  // carries the "checkout expired" state (the on-page toast auto-dismisses too fast to screenshot).
  const HAR_FILE = path.join(LOGS_DIR, `har-${RUN_TS}.har`);
  const context = await browser.newContext({
    userAgent: UA,
    viewport: { width:1280, height:900 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    proxy: proxyOpts,
    recordHar: { path: HAR_FILE, content: 'embed' },
  });
  log(`  HAR recording → ${path.join("logs", `har-${RUN_TS}.har`)}`);
  // Anti-detection: spoof automation signals that bot-detection checks
  await context.addInitScript(() => {
    // ── Webdriver / CDP leak removal ──────────────────────────────────────────
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    try { delete window.navigator.__proto__.webdriver; } catch {}
    // Playwright/CDP leaves a few __playwright_* and cdc_* globals — remove them
    for (const k of Object.keys(window)) {
      if (/^(__playwright|__pw_|cdc_)/i.test(k)) {
        try { delete window[k]; } catch {}
      }
    }

    // ── window.chrome (required by many sites to believe this is real Chrome) ─
    if (!window.chrome) {
      Object.defineProperty(window, 'chrome', {
        get: () => ({
          app: { isInstalled: false },
          runtime: {},
          loadTimes: () => ({}),
          csi: () => ({}),
        }),
      });
    }

    // ── Permissions — headless returns 'denied' for notifications ─────────────
    const _origQuery = window.navigator.permissions?.query?.bind(navigator.permissions);
    if (_origQuery) {
      navigator.permissions.query = (params) =>
        params.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission, onchange: null })
          : _origQuery(params);
    }

    // ── Plugins (empty list = headless bot signal) ────────────────────────────
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const arr = [
          { name: 'Chrome PDF Plugin',  filename: 'internal-pdf-viewer',             description: 'Portable Document Format', length: 1 },
          { name: 'Chrome PDF Viewer',  filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '',                       length: 1 },
          { name: 'Native Client',      filename: 'internal-nacl-plugin',             description: '',                       length: 2 },
        ];
        Object.setPrototypeOf(arr, PluginArray.prototype);
        return arr;
      },
    });

    // ── Navigator properties ──────────────────────────────────────────────────
    Object.defineProperty(navigator, 'languages',           { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
    Object.defineProperty(navigator, 'deviceMemory',        { get: () => 8 });
    Object.defineProperty(navigator, 'platform',            { get: () => 'Win32' });

    // ── Screen / window dimensions ────────────────────────────────────────────
    // Headless Chrome has outerWidth/outerHeight = 0 by default — obvious bot signal
    Object.defineProperty(window, 'outerWidth',       { get: () => 1280 });
    Object.defineProperty(window, 'outerHeight',      { get: () => 900  });
    Object.defineProperty(window, 'innerWidth',       { get: () => 1280 });
    Object.defineProperty(window, 'innerHeight',      { get: () => 900  });
    Object.defineProperty(screen, 'width',            { get: () => 1920 });
    Object.defineProperty(screen, 'height',           { get: () => 1080 });
    Object.defineProperty(screen, 'availWidth',       { get: () => 1920 });
    Object.defineProperty(screen, 'availHeight',      { get: () => 1040 });
    Object.defineProperty(screen, 'colorDepth',       { get: () => 24   });
    Object.defineProperty(screen, 'pixelDepth',       { get: () => 24   });

    // ── WebGL renderer — SwiftShader = massive bot signal ─────────────────────
    // Override getParameter so VENDOR/RENDERER report a real Windows GPU instead of SwiftShader
    const _glGetParam = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(p) {
      if (p === 37445) return 'Google Inc. (NVIDIA)';          // UNMASKED_VENDOR_WEBGL
      if (p === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)';  // UNMASKED_RENDERER_WEBGL
      return _glGetParam.call(this, p);
    };
    try {
      const _gl2 = WebGL2RenderingContext.prototype.getParameter;
      WebGL2RenderingContext.prototype.getParameter = function(p) {
        if (p === 37445) return 'Google Inc. (NVIDIA)';
        if (p === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)';
        return _gl2.call(this, p);
      };
    } catch {}

    // ── iframe contentWindow check ────────────────────────────────────────────
    const _origFn = HTMLIFrameElement.prototype.__lookupGetter__('contentWindow');
    if (_origFn) {
      Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
        get() { const w = _origFn.call(this); if (w) try { w.navigator; } catch {} return w; },
      });
    }
  });

  // ── Transient "checkout expired" toast catcher ──────────────────────────────
  // The expired toast auto-dismisses too fast to screenshot at end-of-run. This watcher
  // fires the instant the text appears and logs it via console (picked up by page.on('console')).
  await context.addInitScript(() => {
    const RX = /checkout (time )?(has )?expired|your (checkout|session) (has )?expired|time (has )?expired/i;
    const seen = new Set();
    const check = () => {
      const txt = document.body?.innerText || '';
      const m = txt.match(RX);
      if (m && !seen.has(m[0])) {
        seen.add(m[0]);
        console.log('___EXPIRED_TOAST___ ' + JSON.stringify({ matched: m[0], hash: location.hash || '' }));
      }
    };
    const start = () => {
      try { new MutationObserver(check).observe(document.body, { childList:true, subtree:true, characterData:true }); } catch {}
      setInterval(check, 200);  // backstop: catch toasts added+removed within one mutation batch
    };
    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start);
  });

  // Load cookies from previous run — but STRIP Queue-It acceptance cookies.
  // Stale acceptance cookies (wrong hash, expired ts) confuse Queue-It's JS into calling
  // storequeue.wizards.com for re-validation, which blocks the page thread for 30s.
  // Queue-It will set a fresh acceptance cookie when the fresh URL is validated.
  const savedCookies = profile.email ? loadSavedCookies(profile.email) : null;
  if (savedCookies?.length) {
    // Strip Queue-It cookies (stale, wrong-hash) AND vipuser (the working browser has neither;
    // vipuser forces Queue-It's "Ignore" path and conflicts with the real acceptance cookie).
    const sessionOnly = savedCookies.filter(c => !/QueueIT|queueIT|queue-it|vipuser/i.test(c.name));
    if (sessionOnly.length) {
      await context.addCookies(sessionOnly).catch(() => {});
      log(`  Loaded saved session cookies (${sessionOnly.length} — Queue-It cookies excluded)`);
    }
  }

  // ── Manual cookie injection (BORROW LIVE SESSION) ──────────────────────────
  // Export your working browser's secretlair.wizards.com cookies to profiles/manual-cookies.json.
  // These are injected UNFILTERED — the QueueITAccepted-* cookie here carries a real
  // server-signed hash, which api.scalefast.com/cart requires (else: errcode -22 "invalid cookie").
  try {
    const manualPath = path.join(PROFILES_DIR, 'manual-cookies.json');
    if (existsSync(manualPath)) {
      const raw = JSON.parse(readFileSync(manualPath, 'utf8'));
      // Accept either a raw array or { cookies: [...] }
      const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.cookies) ? raw.cookies : []);
      // Normalize Cookie-Editor / EditThisCookie format → Playwright format
      const ss = { strict:'Strict', lax:'Lax', no_restriction:'None', none:'None', unspecified:'Lax' };
      const manual = list.map(c => {
        const sameSite = ss[String(c.sameSite || '').toLowerCase()] || 'Lax';
        const out = {
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path || '/',
          httpOnly: !!c.httpOnly,
          secure: sameSite === 'None' ? true : !!c.secure,  // SameSite=None requires Secure
          sameSite,
        };
        const exp = c.expires ?? c.expirationDate;
        if (exp && exp > 0) out.expires = Math.floor(exp);
        return out;
      }).filter(c => c.name && c.value && c.domain);
      if (manual.length) {
        await context.addCookies(manual).catch(e => logErr(`  manual-cookies addCookies: ${e.message}`));
        const qNames = manual.filter(c => /queue/i.test(c.name)).map(c => c.name);
        log(`  Injected ${manual.length} manual cookies (Queue-it: ${qNames.join(', ') || 'none'})`);
      }
    }
  } catch (e) { logErr(`  manual-cookies: ${e.message}`); }

  // Check Queue-It token age — tokens are valid for 10 minutes (600s)
  let _tokenExpired = false;
  try {
    const _qp = new URL(cartUrl.split('#')[0]);
    const _ts = parseInt(_qp.searchParams.get('qitts') || '0', 10);
    if (_ts) {
      const _age = Math.floor(Date.now() / 1000) - _ts;
      _tokenExpired = _age > 600;
      if (_tokenExpired) log(`  ⚠ Queue-it token is ${Math.round(_age/60)} min old — EXPIRED. Need a fresh URL within 10 min of arming the bot.`);
      else               log(`  Queue-it token age: ${_age}s ✓`);
    }
  } catch {}

  // NOTE: we do NOT abort storequeue.wizards.com anymore. Self-acquisition (safetynet)
  // needs storequeue to mint a fresh token. For expired links we skip step 1 instead
  // (see below) so the 31s validation freeze never happens.

  const page = await context.newPage();

  // ── Inline request/response capture (mirrors the P-Bandai [CAPTURE]) — surfaces each meaningful
  // API call and its status LIVE in the task log, so you can watch the flow instead of digging into
  // the HAR after the fact. page.on sees iframe requests too, so Adyen / Queue-it calls show up.
  // Scoped to the checkout endpoints; cookies + queue-it tokens are redacted and PII-bearing
  // profiling/optins bodies are skipped, so the log is safe to paste. (The full HAR still records
  // everything for a deep dive.)
  const _redactUrl = (u) => String(u).replace(/([?&](?:qitq|qitts|qith|token|jwt|hash|sig|signature)=)[^&]+/gi, '$1<redacted>');
  const _CAP_RE  = /scalefast\.com\/(cart|checkout|order|session|profiling|optins|reservation|account|customer)|queue-it\.net|storequeue|checkoutshopper[^"' ]*(payments|details|submitThreeDS)/i;
  const _CAP_SKIP = /\.(js|css|png|jpe?g|svg|woff2?|gif|ico|map|webp)(\?|$)/i;
  const wireCapture = (pg) => {
    pg.on('request', req => { try {
      const u = req.url(); if (!_CAP_RE.test(u) || _CAP_SKIP.test(u)) return;
      const m = req.method(); if (m === 'OPTIONS') return;
      log(`[CAPTURE] → ${m} ${_redactUrl(u).slice(0, 160)}`);
      if (m !== 'GET' && m !== 'HEAD') {
        const b = req.postData();
        if (b && !/profiling|optins/i.test(u)) log(`[CAPTURE]   body ${String(b).slice(0, 400).replace(/\s+/g, ' ')}`); // skip PII-bearing profiling/optins bodies
      }
    } catch {} });
    pg.on('response', async res => { try {
      const u = res.url(); if (!_CAP_RE.test(u) || _CAP_SKIP.test(u) || res.request().method() === 'OPTIONS') return;
      const st = res.status();
      log(`[CAPTURE] ← ${st} ${_redactUrl(u).slice(0, 160)}`);
      if (st >= 400) { const b = await res.text().catch(() => ''); if (b) log(`[CAPTURE]   err-body ${b.slice(0, 400).replace(/\s+/g, ' ')}`); }
    } catch {} });
  };
  wireCapture(page);

  // Log every navigation
  page.on('framenavigated', f => {
    if (f === page.mainFrame()) appendFileSync(LOG_FILE, `[${ts()}]   nav: ${f.url()}\n`);
  });
  // Auto-accept browser dialogs (alert, confirm, beforeunload "Leave page?" prompts)
  page.on('dialog', async d => {
    appendFileSync(LOG_FILE, `[${ts()}]   dialog: ${d.type()} "${d.message().slice(0, 60)}"\n`);
    await d.accept().catch(() => {});
  });
  // Log console errors from the page
  page.on('pageerror', e => appendFileSync(LOG_FILE, `[${ts()}]   page-err: ${e.message}\n`));
  // Catch the transient "checkout expired" toast the instant the in-page watcher detects it
  page.on('console', msg => {
    const t = msg.text();
    if (t.startsWith('___EXPIRED_TOAST___')) {
      appendFileSync(LOG_FILE, `[${ts()}]   ⚠ EXPIRED TOAST: ${t.replace('___EXPIRED_TOAST___ ', '')}\n`);
      screenshot(page, 'expired-toast').catch(() => {});
    }
  });

  // Watch for cart API response
  let cartOk = false;
  page.on('response', async resp => {
    if (!resp.url().includes('api.scalefast.com/cart') || resp.request().method()!=='POST') return;
    try { const j = await resp.json(); if (j?.result?.status==='OK') cartOk = true; } catch {}
  });

  // A 407 from ANY request means the paired proxy refused auth (a dead/expired token-bound proxy) —
  // surface it LOUD and once, because the raw Chromium failure is only "ERR_HTTP_RESPONSE_CODE_FAILURE".
  let proxyRejected = false;

  // Real-time API body logger: capture checkout/cart/session responses that signal an error
  // or contain "expired". Writes to the log immediately (no HAR-close needed) so we can see
  // exactly which API call returns the "checkout expired" state.
  page.on('response', async resp => {
    const u = resp.url();
    if (resp.status() === 407 && !proxyRejected) {
      proxyRejected = true;
      // Don't assert a cause here. This message used to claim the proxy was "dead/expired", which
      // was wrong and cost real debugging time — the actual fault was the password arriving with
      // Discord spoiler markup attached. Report the fact and point at the line that distinguishes
      // a mangled credential from a genuine refusal.
      log(`  ⛔ PROXY REJECTED (HTTP 407): ${proxy?.ip || 'paired proxy'} refused these credentials. Check the "pass N chars" above matches the real password length — if it doesn't, the credential was mangled in transit, not expired.`);
    }
    if (!/scalefast|secretlair\.wizards|checkout|session|reservation|queue-it|storequeue/i.test(u)) return;
    if (/\.(js|css|png|jpe?g|svg|woff2?|gif|ico|map)(\?|$)/i.test(u)) return;  // skip static assets
    try {
      const body = await resp.text();
      if (resp.status() >= 400 || /expired|denied|invalid|reject|not.?allowed|forbidden|"error"/i.test(body)) {
        appendFileSync(LOG_FILE,
          `[${ts()}]   ⚠ API ${resp.status()} ${resp.request().method()} ${u.slice(0,140)}\n` +
          `              body: ${body.slice(0,500).replace(/\s+/g,' ')}\n`);
      }
    } catch {}
  });

  postProfiling(profile, qty);
  postOptins(profile);

  try {
    const { productUrl, variant } = config;

    // Step timer
    let _st = Date.now();
    function lap() { const s = ((Date.now()-_st)/1000).toFixed(1); _st=Date.now(); return `${s}s`; }

    // helper: wait for URL hash to change (Angular route navigation)
    const waitForHash = (hash, ms=8000) =>
      page.waitForFunction(h => location.hash.includes(h), hash, { timeout:ms }).catch(()=>{});

    // ── Step 1: Bypass URL → Queue-it validates → timer appears ───────────────
    // Only visit the queue URL if it's FRESH. An expired token just freezes for 31s on
    // storequeue validation and never works — skip it and self-acquire on /cart instead
    // (same safetynet path that succeeds in --no-queue mode).
    if (hasQueueUrl && !_tokenExpired) {
      log('  [1] Visiting bypass URL (Queue-it)...');
      await page.goto(cartUrl, { waitUntil:'domcontentloaded', timeout:20000 }).catch(() => {});
      // Give Queue-It's JS up to 8s to show the timer (fresh token resolves in 1-3s)
      const timerFound = await page.waitForFunction(
        () => /to check out|minutes? remaining|checkout time|timer/i.test(document.body?.innerText||''),
        { timeout:8000 }
      ).then(()=>true).catch(()=>false);
      await screenshot(page, '1-queueit-state');
      if (timerFound) log('  Queue-it validated — timer visible');
      else            log('  Queue-it timer not detected (bot-detection?)');
      log(`  [step 1: ${lap()}]`);
    } else if (hasQueueUrl && _tokenExpired) {
      log('  [1] Skipped — queue link expired; will self-acquire a fresh token on /cart');
    } else {
      log('  [1] Skipped (no queue URL — direct checkout mode, self-acquire on /cart)');
    }

    // ── Step 2: Product page → add to cart ─────────────────────────────────
    log('  [2] Adding item to cart...');
    await gotoWithRetry(page, productUrl, 'product');
    // Wait up to 10s for Angular to render the Add to Cart button, then click immediately
    const ATC_SEL = "[data-internal-id='add-to-cart'], button:has-text('Add to Cart'), button:has-text('Add to Bag'), [ng-click*='addToCart']";
    await page.waitForSelector(ATC_SEL, { timeout:10000 }).catch(()=>{});

    if (variant) {
      for (const sel of [
        `button:has-text("${variant}")`,
        `[data-value*="${variant}" i]`,
        `[data-variant*="${variant}" i]`,
        `label:has-text("${variant}")`,
      ]) {
        try { await page.click(sel,{timeout:300}); break; } catch {}
      }
      await page.waitForTimeout(150);
    }
    // Set quantity — set directly on the AngularJS scope so cart.addQuantity is correct
    // when the Add to Cart function reads it (DOM value alone isn't enough)
    if (qty > 1) {
      const qtySet = await page.evaluate((q) => {
        const sels = [
          "select[ng-model='cart.addQuantity']",
          "select[ng-model*='addQuantity']",
          "select[ng-model*='quantity']",
          "select[ng-model*='qty']",
          "select[id*='quantity']", "select[name='quantity']",
        ];
        for (const s of sels) {
          const el = document.querySelector(s);
          if (!el) continue;
          try {
            // Walk the dot-path on the scope: "cart.addQuantity" → scope.cart.addQuantity = q
            const ng    = window.angular?.element(el);
            const scope = ng?.scope();
            if (scope) {
              const parts = (el.getAttribute('ng-model') || '').split('.');
              let obj = scope;
              for (let i = 0; i < parts.length - 1; i++) obj = obj[parts[i]];
              obj[parts[parts.length - 1]] = q;
              if (!scope.$phase) scope.$apply();
              return true;
            }
          } catch {}
          // DOM fallback: match option by label text
          const opt = [...el.options].find(o => o.text.trim() === String(q));
          if (!opt) continue;
          el.value = opt.value;
          el.dispatchEvent(new Event('change', { bubbles:true }));
          return true;
        }
        return false;
      }, qty);
      if (qtySet) log(`    qty set to ${qty}`);
      else        log(`    qty selector not found — defaulting to 1`);
      await page.waitForTimeout(400);
    }

    let added = false;
    for (const sel of [
      ATC_SEL,
      "[data-internal-id='add-to-cart']",
      "button:has-text('Add to Cart')",
      "button:has-text('Add to Bag')",
      "[ng-click*='addToCart']",
    ]) {
      try { await page.click(sel,{timeout:1000}); added=true; log(`    add-to-cart clicked (${sel.slice(0,40)})`); break; } catch {}
    }
    if (!added) {
      await screenshot(page, '2-FAIL-add-to-cart');
      await dumpPage(page, 'add-to-cart');
      throw new Error('Could not click Add to Cart');
    }
    // Wait for cart API to register the item before navigating away
    await page.waitForTimeout(200);
    log(`  [step 2: ${lap()}]`);

    // ── Step 3 (was 2): Navigate back to cart ──────────────────────────────
    log('  [3] Back to cart...');
    await page.goto(`${ORIGIN}/us/cart#/cart`, { waitUntil:'domcontentloaded', timeout:15000 });
    log('    cart page loaded');
    // Wait for Angular to finish rendering — specifically wait for an interactive
    // element with "Secure Checkout" text, not just the static text that appears
    // immediately in the page skeleton (sidebar copy) before Angular boots.
    await page.waitForFunction(() => {
      return [...document.querySelectorAll('button, a, [ng-click], [data-internal-id]')]
        .some(el => /secure checkout/i.test(el.textContent?.trim()));
    }, { timeout: 10000 }).catch(()=>{});

    // ── Self-acquire Queue-It token (safetynet) ────────────────────────────────
    // Landing on /cart triggers Queue-It integration #5. When there's no active queue,
    // Queue-It's safetynet mode issues a signed QueueITAccepted-* cookie automatically —
    // one bound to THIS context's IP (so each proxied task gets its own valid token).
    // We wait for that cookie before checkout; without it api.scalefast.com/cart returns -22.
    const hasQueueCookie = async () =>
      (await page.context().cookies().catch(() => [])).find(c => /^QueueITAccepted/i.test(c.name));
    let qCookie = await hasQueueCookie();
    if (qCookie) {
      log(`  Queue-it token already present: ${qCookie.name}`);
    } else {
      log('  Waiting for Queue-it to issue a token (safetynet self-acquire)...');
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline) {
        await page.waitForTimeout(400);
        qCookie = await hasQueueCookie();
        if (qCookie) break;
      }
      if (qCookie) log(`  ✓ Queue-it token acquired: ${qCookie.name}`);
      else         log('  ⚠ No Queue-it token issued in 12s — checkout may fail with -22 (storequeue blocked for this IP, or active queue requires a real pass)');
    }

    const itemCount = await page.evaluate(() => {
      try {
        const sc = window.angular?.element(document.querySelector('[ng-app],[data-ng-app]'))?.scope();
        return sc?.$root?.cart?.items?.length ?? sc?.cart?.items?.length ?? -1;
      } catch { return -1; }
    }).catch(()=>-1);
    log(`  Angular cart items: ${itemCount === -1 ? 'unknown' : itemCount}`);

    // Detect "drop ended" / Queue-it rejected — only flag if cart is empty
    const pageText = await page.evaluate(()=>document.body?.innerText||'').catch(()=>'');
    const cartEmpty = itemCount === 0 || itemCount === -1;
    const looksLikeNewsletter = /sign up to get notified|for your eyes|coming soon|notify me|be the first/i.test(pageText)
                             && !/secure checkout|your cart \d/i.test(pageText);
    if (cartEmpty && looksLikeNewsletter) {
      await screenshot(page, '3-FAIL-wrong-page');
      throw new Error('Cart empty + newsletter page — token likely used/expired or drop ended.');
    }
    log(`  [step 3: ${lap()}]`);

    // ── Step 4: Secure Checkout ─────────────────────────────────────────────
    log('  [4] Clicking Secure Checkout...');

    // Log elements for debugging (written to log file only)
    const clickables = await page.evaluate(() =>
      [...document.querySelectorAll('a,button,[ng-click],[data-internal-id]')]
        .map(e => `${e.tagName}|${e.getAttribute('data-internal-id')||''}|${e.textContent?.trim().slice(0,50)}`)
        .filter(s => /checkout|continue/i.test(s))
    ).catch(()=>[]);
    clickables.forEach(c => appendFileSync(LOG_FILE, `[${ts()}]     el: ${c}\n`));

    // Cookie/newsletter overlays sit on top of the cart and swallow a coordinate-based click, so the
    // page silently stays on the Cart step — the bot then fills the HIDDEN Info template and loops
    // "regressed to Info" (exactly the "stuck at cart" symptom). Fix: dismiss overlays, click Secure
    // Checkout via a DIRECT in-page ng-click (bypasses overlays + the hidden duplicate button), and
    // VERIFY the page actually left Cart (shipping form or guest choice on-screen) before proceeding.
    let checkoutClicked = false;
    const coDeadline = Date.now() + 15000;
    await dismissOverlays(page);
    while (Date.now() < coDeadline) {
      const fired = await page.evaluate(() => {
        const ok = el => !!(el && el.offsetParent !== null && !el.disabled &&
                            /secure checkout/i.test(el.textContent || ''));
        const btn = [...document.querySelectorAll('[data-internal-id="cart-continue"], button')].find(ok);
        if (!btn) return false;
        btn.scrollIntoView({ block: 'center' });
        btn.click();
        return true;
      }).catch(() => false);
      if (fired) log('    clicked: Secure Checkout (in-page ng-click)');
      else {
        // No visible in-page node — try a real Playwright force-click as a fallback
        try {
          await page.locator('[data-internal-id="cart-continue"]:not([disabled]):visible').first()
            .click({ timeout: 1500, force: true });
          log('    clicked: Secure Checkout (force)');
        } catch {}
      }
      // Verify we ACTUALLY left the Cart step: the shipping form OR the guest/login choice is on-screen.
      const advanced = await page.waitForFunction(() => {
        const vis = el => !!(el && el.offsetParent !== null);
        const fn = document.querySelector('input[ng-model*="firstname"],input[ng-model*="firstName"],input[id*="first"],input[placeholder*="First" i]');
        if (vis(fn)) return true;
        return [...document.querySelectorAll('button')].some(b => vis(b) && /continue as guest/i.test(b.textContent || ''));
      }, { timeout: 2500 }).then(() => true).catch(() => false);
      if (advanced) { checkoutClicked = true; log('    ✓ advanced past Cart'); break; }
      await dismissOverlays(page); // a modal may have popped over the button after the click
    }

    if (!checkoutClicked) {
      await screenshot(page, '3-FAIL-no-checkout-btn');
      await dumpPage(page, 'no-checkout-btn');
      throw new Error('Could not advance past Cart (Secure Checkout)');
    }

    log(`    route: ${page.url().split('#')[1] || '?'}`);

    // Diagnostic: dump client-side storage + any visible error/toast right after Secure Checkout.
    // The "cart_US" null error points at missing localStorage state — this shows what's actually there.
    try {
      const diag = await page.evaluate(() => {
        const lsKeys = Object.keys(localStorage);
        const ssKeys = Object.keys(sessionStorage);
        const cartLike = {};
        for (const k of lsKeys) if (/cart|checkout|session|queue|scalefast/i.test(k)) cartLike[k] = localStorage.getItem(k)?.slice(0, 200);
        // Any visible toast / error / expired banner
        const toast = [...document.querySelectorAll('[class*="toast" i],[class*="notif" i],[class*="alert" i],[class*="error" i],[role="alert"]')]
          .filter(e => e.offsetParent !== null && e.textContent?.trim())
          .map(e => e.textContent.trim().slice(0, 150));
        return { lsKeys, ssKeys, cartLike, toast };
      });
      appendFileSync(LOG_FILE, `[${ts()}]   diag-ls-keys: ${JSON.stringify(diag.lsKeys)}\n`);
      appendFileSync(LOG_FILE, `[${ts()}]   diag-ss-keys: ${JSON.stringify(diag.ssKeys)}\n`);
      appendFileSync(LOG_FILE, `[${ts()}]   diag-cart-storage: ${JSON.stringify(diag.cartLike)}\n`);
      if (diag.toast.length) appendFileSync(LOG_FILE, `[${ts()}]   diag-visible-toast: ${JSON.stringify(diag.toast)}\n`);
    } catch {}

    // ── Step 4: Handle login/guest modal, then fill shipping form ──────────
    log('  [4] Filling shipping form...');
    // The Scalefast Angular app shows the shipping form WITHIN the /cart hash (route stays /cart).
    // After Secure Checkout, a login/guest modal MAY appear. Only click "Continue as guest"
    // if it's actually VISIBLE — the button exists hidden in the DOM otherwise.
    const guestBtn = page.getByRole('button', { name: /continue as guest/i }).first();
    try {
      if (await guestBtn.isVisible({ timeout: 2000 })) {
        await guestBtn.scrollIntoViewIfNeeded();
        await guestBtn.click({ timeout: 2000 });
        log('    clicked: Continue as guest (visible modal)');
        await page.waitForTimeout(1200);
      }
    } catch {}

    // Wait for the shipping form to appear — specifically a firstname input (not in login modal)
    await page.waitForSelector(
      'input[ng-model*="firstname"], input[ng-model*="firstName"], input[id*="first"], input[placeholder*="First"]',
      { timeout: 8000 }
    ).catch(() => {});
    log(`    route after checkout: ${page.url().split('#')[1] || '?'}`);

    const addr = profile.address2 ? `${profile.address1} ${profile.address2}` : profile.address1;

    // Fill all text fields — set value + fire events + force Angular $apply so model is marked valid
    await page.evaluate(({ p, addr }) => {
      function ngSet(sels, val) {
        for (const s of sels) {
          const el = document.querySelector(s);
          if (!el) continue;
          el.value = val;
          el.dispatchEvent(new Event('input',  { bubbles:true }));
          el.dispatchEvent(new Event('change', { bubbles:true }));
          return;
        }
      }
      ngSet(['input[type="email"]','input[ng-model*="email"]'], p.email);
      ngSet(['input[ng-model*="firstname"]','input[id*="first"]','input[placeholder*="First"]'], p.firstName);
      ngSet(['input[ng-model*="lastname"]', 'input[id*="last"]', 'input[placeholder*="Last"]'],  p.lastName);
      // Line 1 = street, line 2 = apt/suite/box → SEPARATE fields; concatenate into line 1 only when
      // the form has no line-2 field, so a unit/box number is never merged into the street or dropped.
      {
        const L2 = 'input[ng-model*="address2"],input[ng-model*="address_2"],input[ng-model*="addressLine2"],input[ng-model*="line2"],input[id*="address2"],input[placeholder*="apt" i],input[placeholder*="suite" i],input[placeholder*="unit" i],input[placeholder*="line 2" i]';
        if (document.querySelector(L2)) {
          ngSet(['input[ng-model*="address"]:not([ng-model*="address2"]):not([ng-model*="address_2"])','input[id*="address"]:not([id*="address2"])'], p.address1 || '');
          ngSet(L2.split(','), p.address2 || '');
        } else {
          ngSet(['input[ng-model*="address"]','input[id*="address"]'], addr);
        }
      }
      ngSet(['input[ng-model*="city"]',     'input[id*="city"]'],                                p.city);
      ngSet(['input[ng-model*="zip"]','input[ng-model*="postal"]','input[id*="zip"]'],           p.zip);
      ngSet(['input[type="tel"]','input[ng-model*="phone"]','input[id*="phone"]'],               p.phone);
      // Force Angular to process all model changes in one digest cycle
      try {
        const inj = window.angular?.element(document.documentElement)?.injector();
        const rs  = inj?.get('$rootScope');
        if (rs && !rs.$$phase) rs.$apply();
      } catch {}
    }, { p: profile, addr });
    log('    fields filled');

    // Country + state selects — wait for state options to populate instead of fixed delay
    await ngSelect(page, 'select[data-internal-id="cart-shipping-country"]', 'US');
    const stateSel = 'select[ng-model*="state"],select[ng-model*="province"],select[id*="state"]';
    await page.waitForFunction(
      (sel) => { const el = document.querySelector(sel); return el && el.options.length > 1; },
      stateSel, { timeout: 1500 }
    ).catch(() => {});
    const stateCode = toStateCode(profile.state);
    // Try code (TX), then full name (Texas) — ScaleFast uses one or the other
    const stateOk = await ngSelect(page, stateSel, stateCode);
    if (!stateOk) await ngSelect(page, stateSel, toStateName(profile.state));
    // screenshot skipped for speed (4-shipping-form-filled)

    // Click Continue to Shipping — only use precise selectors to avoid clicking wrong button
    async function clickContinueToShipping() {
      for (const sel of [
        "button:has-text('Continue to Shipping')",
        "button:has-text('Continue to shipping')",
        "[data-internal-id='cart-continue']",
        "button[data-internal-id*='continue']",
      ]) {
        try { await page.click(sel,{timeout:1500}); log(`    continue clicked (${sel})`); return true; } catch {}
      }
      return false;
    }
    let continueClicked = await clickContinueToShipping();
    if (!continueClicked) {
      const btnTexts = await page.evaluate(() =>
        [...document.querySelectorAll('button')].map(b => b.textContent?.trim()).filter(Boolean)
      ).catch(()=>[]);
      log(`    continue NOT clicked — buttons: ${JSON.stringify(btnTexts)}`);
    }
    // Helpers reused by the step-4 retry loop and the step-5 regression recovery
    async function refillShippingAndContinue() {
      await page.evaluate(({ p, addr }) => {
        function ngSet(sels, val) {
          for (const s of sels) {
            const el = document.querySelector(s);
            if (!el) continue;
            el.value = val;
            el.dispatchEvent(new Event('input',  { bubbles:true }));
            el.dispatchEvent(new Event('change', { bubbles:true }));
            return;
          }
        }
        ngSet(['input[type="email"]','input[ng-model*="email"]'], p.email);
        ngSet(['input[ng-model*="firstname"]','input[id*="first"]','input[placeholder*="First"]'], p.firstName);
        ngSet(['input[ng-model*="lastname"]', 'input[id*="last"]', 'input[placeholder*="Last"]'],  p.lastName);
        {
          const L2 = 'input[ng-model*="address2"],input[ng-model*="address_2"],input[ng-model*="addressLine2"],input[ng-model*="line2"],input[id*="address2"],input[placeholder*="apt" i],input[placeholder*="suite" i],input[placeholder*="unit" i],input[placeholder*="line 2" i]';
          if (document.querySelector(L2)) {
            ngSet(['input[ng-model*="address"]:not([ng-model*="address2"]):not([ng-model*="address_2"])','input[id*="address"]:not([id*="address2"])'], p.address1 || '');
            ngSet(L2.split(','), p.address2 || '');
          } else {
            ngSet(['input[ng-model*="address"]','input[id*="address"]'], addr);
          }
        }
        ngSet(['input[ng-model*="city"]',     'input[id*="city"]'],                                p.city);
        ngSet(['input[ng-model*="zip"]','input[ng-model*="postal"]','input[id*="zip"]'],           p.zip);
        ngSet(['input[type="tel"]','input[ng-model*="phone"]','input[id*="phone"]'],               p.phone);
        try {
          const inj = window.angular?.element(document.documentElement)?.injector();
          const rs  = inj?.get('$rootScope');
          if (rs && !rs.$$phase) rs.$apply();
        } catch {}
      }, { p: profile, addr });
      await ngSelect(page, 'select[data-internal-id="cart-shipping-country"]', 'US');
      await page.waitForFunction(
        (sel) => { const el = document.querySelector(sel); return el && el.options.length > 1; },
        stateSel, { timeout: 1500 }
      ).catch(() => {});
      const sc = toStateCode(profile.state);
      if (!await ngSelect(page, stateSel, sc)) await ngSelect(page, stateSel, toStateName(profile.state));
      await clickContinueToShipping();
    }
    async function pageAtInfoStep() {
      return page.evaluate(() =>
        /sign in|create an account/i.test(document.body?.innerText||'') &&
        !/continue to payment|shipping method/i.test(document.body?.innerText||'')
      ).catch(()=>false);
    }

    // Detect payment page OR regression the instant either appears (no 20s wasted wait)
    async function waitForPaymentOrRegression(ms = 25000) {
      return Promise.race([
        page.waitForFunction(
          () => [...document.querySelectorAll('button')].some(b => /continue to payment/i.test(b.textContent||'')),
          { timeout: ms }
        ).then(() => 'payment').catch(() => 'timeout'),
        page.waitForFunction(
          () => /sign in|create an account/i.test(document.body?.innerText||'') &&
                !/continue to payment|shipping method/i.test(document.body?.innerText||''),
          { timeout: ms }
        ).then(() => 'regressed').catch(() => 'timeout'),
      ]);
    }

    // Wait for "Continue to Payment" — retry up to 3x when server regresses to Info step
    for (let regRetry = 0; regRetry < 3; regRetry++) {
      const outcome = await waitForPaymentOrRegression();
      if (outcome === 'payment') break;
      if (outcome === 'timeout' && !await pageAtInfoStep()) break;
      log(`    page regressed to Info step — retry ${regRetry + 1}/3`);
      await refillShippingAndContinue();
    }
    if (cartOk) log('  cart API: confirmed OK');
    log(`  [step 4: ${lap()}]`);

    // ── Step 5: Shipping options → Continue to Payment ──────────────────────
    log('  [5] Continuing to payment...');

    // Click specifically a BUTTON (not a div) whose text is "Continue to Payment"
    let payClicked = false;
    for (const loc of [
      page.locator('button', { hasText:/^continue to payment$/i }).first(),
      page.locator('button', { hasText:/continue to payment/i }).first(),
      page.locator('button', { hasText:/continue to pay/i }).first(),
    ]) {
      try {
        await loc.waitFor({ timeout:4000 });
        await loc.scrollIntoViewIfNeeded();
        await loc.click();
        payClicked = true;
        log('    clicked: Continue to Payment button');
        break;
      } catch {}
    }

    // JS fallback: only look at BUTTON elements with short text
    if (!payClicked) {
      const jsResult = await page.evaluate(() => {
        for (const btn of document.querySelectorAll('button')) {
          const txt = btn.textContent?.trim() || '';
          if (/continue to payment/i.test(txt) && txt.length < 40) {
            btn.click();
            return txt;
          }
        }
        return null;
      }).catch(()=>null);
      if (jsResult) { log(`    JS clicked: "${jsResult}"`); payClicked = true; }
    }

    // Recovery: if the server regressed to Info step again between step 4 and step 5,
    // re-run the shipping form and attempt clicking "Continue to Payment" once more.
    if (!payClicked && await pageAtInfoStep()) {
      log('  [5] Page regressed to Info step — re-running shipping form...');
      for (let regRetry = 0; regRetry < 3; regRetry++) {
        await refillShippingAndContinue();
        const outcome5 = await waitForPaymentOrRegression();
        if (outcome5 === 'payment') {
          for (const loc of [
            page.locator('button', { hasText:/^continue to payment$/i }).first(),
            page.locator('button', { hasText:/continue to payment/i }).first(),
          ]) {
            try {
              await loc.waitFor({ timeout:3000 });
              await loc.scrollIntoViewIfNeeded();
              await loc.click();
              payClicked = true;
              log('    clicked: Continue to Payment (recovered from step-5 regression)');
              break;
            } catch {}
          }
          if (payClicked) break;
        }
        if (!await pageAtInfoStep()) break;
        if (regRetry < 2) log(`    still regressed — retry ${regRetry + 2}/3`);
      }
    }

    if (!payClicked) {
      await screenshot(page, '5-FAIL-no-pay-btn');
      await dumpPage(page, 'no-pay-btn');
      // Log all visible button texts so we know the exact label
      const btnTexts = await page.evaluate(() =>
        [...document.querySelectorAll('button')].map(b => b.textContent?.trim()).filter(Boolean)
      ).catch(()=>[]);
      appendFileSync(LOG_FILE, `[${ts()}]   buttons on page: ${JSON.stringify(btnTexts)}\n`);
    }

    log(`    route: ${page.url().split('#')[1] || '?'}`);
    log(`  [step 5: ${lap()}]`);

    // If we never reached the payment page despite all retries, skip the Adyen wait
    // entirely (can't load on the Info page) and go straight to manual fallback.
    if (!payClicked) {
      logErr('    Payment page unreachable after all retries — launching manual fallback');
      await launchManualFallback(page, page.url(), proxy);
      return { result: 'manual' };
    }

    // ── Step 6: Adyen card payment ──────────────────────────────────────────
    if (!profile.card) {
      log('  No card configured — stopping before payment');
      return { result:'no-card' };
    }

    log('  [6] Waiting for Adyen iframes...');
    // Retry up to 3 times with escalating timeouts before giving up and opening manual browser
    let adyenReady = false;
    const adyenWaits = [20000, 30000, 45000];
    for (let attempt = 1; attempt <= 3; attempt++) {
      adyenReady = await page.waitForFunction(() => {
        const adyen = [...document.querySelectorAll('iframe')]
          .filter(f => (f.src||'').includes('checkoutshopper'));
        return adyen.length >= 3;
      }, { timeout: adyenWaits[attempt - 1] }).then(()=>true).catch(()=>false);
      if (adyenReady) break;
      if (attempt < 3) log(`    Adyen not ready — retry ${attempt}/2, giving ${adyenWaits[attempt] / 1000}s more...`);
    }

    if (!adyenReady) {
      logErr('    Adyen iframes did not appear after 3 attempts — launching manual fallback');
      await launchManualFallback(page, page.url(), proxy);
      return { result: 'manual' };
    }

    // Log ALL iframes and ALL frames for debugging
    const iframeTitles = await page.evaluate(()=>
      [...document.querySelectorAll('iframe')].map(f=>`title="${f.title}" src="${(f.src||'').slice(0,80)}"`)
    ).catch(()=>[]);
    iframeTitles.forEach(t=>appendFileSync(LOG_FILE,`[${ts()}]     iframe: ${t}\n`));
    page.frames().forEach(f=>appendFileSync(LOG_FILE,`[${ts()}]     frame: ${f.url().slice(0,80)}\n`));

    // Scroll card-number iframe into view from the parent page so the page settles there
    await page.evaluate(() => {
      const iframe = document.querySelector('iframe[title="Iframe for card number"]')
                  ?? document.querySelectorAll('iframe[src*="checkoutshopper"]')[0];
      iframe?.scrollIntoView({ behavior:'instant', block:'center' });
    }).catch(()=>{});
    await page.waitForTimeout(700); // give Adyen SecuredFields time to fully initialize inputs
    log(`  [step 6: ${lap()}]`);

    log('  [7] Filling card details...');
    await fillAdyenCard(page, profile.card);
    await page.waitForTimeout(200);
    log(`  [step 7: ${lap()}]`);

    // ── Cookie banner dismiss helper (called before any critical click) ─────
    const dismissCookies = () => page.evaluate(() => {
      const btns = [...document.querySelectorAll('button, a[role="button"]')];
      const accept = btns.find(b => /accept cookies|accept all/i.test((b.textContent||'').trim()));
      if (accept) { accept.click(); return true; }
      return false;
    }).catch(() => false);

    // ── Step 8: Submit card → goes to Billing Address step ─────────────────
    log('  [8] Submitting card / going to billing...');
    await dismissCookies();
    await page.waitForTimeout(300);

    let reviewClicked = false;
    for (const loc of [
      page.locator('[data-internal-id="cart-continue-creditcard"]').first(),
      page.locator('button', { hasText:/^review order$/i }).first(),
      page.locator('button', { hasText:/review order/i }).first(),
    ]) {
      try {
        await loc.waitFor({ timeout:5000 });
        await loc.scrollIntoViewIfNeeded();
        await loc.click();
        reviewClicked = true;
        log('    clicked: submit card');
        break;
      } catch {}
    }
    if (!reviewClicked) log('    card submit button not found');
    log(`  [step 8: ${lap()}]`);

    // ── Step 9: Billing Address (Scalefast shows this before order review) ──
    await page.waitForTimeout(1200);
    await dismissCookies();

    const billingPageText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
    if (/billing address/i.test(billingPageText)) {
      log('  [9] Billing address step — confirming same as shipping...');

      // Make sure "Same as shipping address" radio is selected (first radio)
      await page.evaluate(() => {
        const radios = document.querySelectorAll('input[type="radio"]');
        if (radios.length > 0 && !radios[0].checked) radios[0].click();
      }).catch(() => {});
      await page.waitForTimeout(500);

      // Scroll to reveal the submit button below the form
      await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }));
      await page.waitForTimeout(600);
      await dismissCookies();
      await page.waitForTimeout(300);

      // Find and click the billing submit button
      // "Review Order" is the Scalefast billing-page submit (same text as payment submit)
      let billingSubmitted = false;
      for (const loc of [
        page.locator('button', { hasText:/^review order$/i }).first(),
        page.locator('button', { hasText:/review order/i }).first(),
        page.locator('button', { hasText:/place order/i }).first(),
        page.locator('button', { hasText:/confirm order/i }).first(),
        page.locator('button', { hasText:/submit order/i }).first(),
        page.locator('[data-internal-id="cart-continue-billing"]').first(),
      ]) {
        try {
          await loc.waitFor({ timeout:4000 });
          await loc.scrollIntoViewIfNeeded();
          const txt = await loc.textContent().catch(() => '');
          await loc.click();
          billingSubmitted = true;
          log(`    billing submitted (${txt.trim().slice(0, 40)})`);
          break;
        } catch {}
      }

      if (!billingSubmitted) {
        // Log all visible button texts for debugging
        const btns = await page.evaluate(() =>
          [...document.querySelectorAll('button')].map(b => b.textContent?.trim()).filter(Boolean)
        ).catch(() => []);
        log(`    billing submit not found — buttons: ${JSON.stringify(btns)}`);
        await screenshot(page, '9-FAIL-billing-no-submit');
      }

      await page.waitForTimeout(2000);
      log(`  [step 9: ${lap()}]`);
    } else {
      log('  [9] No billing address step detected — skipping');
      log(`  [step 9: ${lap()}]`);
    }

    // Extract order total (works on billing confirmation or review page)
    const orderTotal = await page.evaluate(() => {
      const text = document.body?.innerText || '';
      const labeled = text.match(/(?:order\s+)?total[:\s$]+(\$?\s*[\d,]+\.\d{2})/i);
      if (labeled) return labeled[1].trim().startsWith('$') ? labeled[1].trim() : '$' + labeled[1].trim();
      const all = [...text.matchAll(/\$\s*[\d,]+\.\d{2}/g)].map(m => ({
        raw: m[0].replace(/\s/g,''),
        val: parseFloat(m[0].replace(/[$,\s]/g,''))
      }));
      if (!all.length) return null;
      return all.reduce((a,b) => b.val > a.val ? b : a).raw;
    }).catch(()=>null);
    if (orderTotal) log(`  order total: ${orderTotal}`);

    // ── Step 10: Place Order ────────────────────────────────────────────────
    log('  [10] Clicking Place Order...');
    await dismissCookies();
    await page.waitForTimeout(300);

    // The final "Place Order" lives on the Review page, which the billing "Review Order"
    // click advances to. On slow proxies that render can lag — so retry: if Place Order
    // isn't there yet but a "Review Order" still is, click it to advance, then look again.
    const placeOrderLocators = () => [
      page.locator('[data-internal-id="cart-submit-order"]').first(),
      page.locator('[data-internal-id*="submit"]').first(),
      page.locator('[data-internal-id*="place"]').first(),
      page.locator('[data-internal-id*="confirm"]').first(),
      page.locator('button', { hasText:/^place order$/i }).first(),
      page.locator('button', { hasText:/place order/i }).first(),
      page.locator('button', { hasText:/confirm order/i }).first(),
      page.locator('button', { hasText:/submit order/i }).first(),
      page.locator('button', { hasText:/pay now/i }).first(),
    ];
    let orderClicked = false;
    let declined = false;   // set when Adyen refuses the card at Place Order
    for (let attempt = 0; attempt < 4 && !orderClicked; attempt++) {
      await dismissCookies();
      for (const loc of placeOrderLocators()) {
        try {
          await loc.waitFor({ state:'visible', timeout: 3500 });
          await loc.scrollIntoViewIfNeeded();
          const txt = await loc.textContent().catch(() => '');
          await loc.click();
          orderClicked = true;
          log(`    clicked: ${txt.trim().slice(0, 40)}`);
          break;
        } catch {}
      }
      if (orderClicked) break;
      // Place Order not present yet — if a "Review Order" step is still showing, advance it.
      const advanced = await page.evaluate(() => {
        const b = [...document.querySelectorAll('button')]
          .find(x => /review order/i.test(x.textContent || '') && x.offsetParent !== null);
        if (b) { b.click(); return true; }
        return false;
      }).catch(() => false);
      // A DECLINE lands here: Adyen refuses the payment, the page drops back to the payment step
      // and clears its card fields, so Place Order is gone and we loop "still on Review" until we
      // give up with a generic failure. Look for the refusal text and say so plainly — a declined
      // card and a broken checkout are completely different problems and looked identical before.
      const declineText = await page.evaluate(() => {
        // Wizards' actual toast is "There is a problem with your credit card. Please try another
        // card". "problem with your credit card" is listed separately because the toast can render
        // as two elements, and the first line alone matches none of the generic refusal wording.
        const rx = /(refused|declin|problem with your (credit )?card|payment (was )?(not|un)?\s*authoris|unsuccessful|try (again|another card)|invalid card|insufficient)/i;
        const seen = [];
        for (const el of document.querySelectorAll('div,span,p,h1,h2,h3,li,[role="alert"]')) {
          const t = (el.textContent || '').trim();
          // Cap the length so a whole page body containing the word "declined" somewhere can't
          // masquerade as the message; prefer the smallest element that still matches.
          if (t && t.length < 200 && rx.test(t) && el.offsetParent !== null) seen.push(t);
        }
        if (!seen.length) return '';
        return seen.sort((a, b) => a.length - b.length)[0];
      }).catch(() => '');
      if (declineText) {
        log(`  ⛔ DECLINED: ${declineText}`);
        await screenshot(page, '10-DECLINED');
        declined = true;
        break;
      }

      if (advanced) { log(`    still on Review step — advanced (attempt ${attempt + 1}/4)`); await page.waitForTimeout(2500); }
      else { await page.waitForTimeout(1500); }
    }

    if (!orderClicked && !declined) {
      const btns = await page.evaluate(() =>
        [...document.querySelectorAll('button')].map(b => b.textContent?.trim()).filter(Boolean)
      ).catch(() => []);
      log(`    Place Order not found — buttons on page: ${JSON.stringify(btns)}`);
      await screenshot(page, '10-FAIL-no-place-order');
    }
    log(`  [step 10: ${lap()}]`);

    // ── Step 10: Result ─────────────────────────────────────────────────────
    log('  [10] Waiting for payment result...');
    await page.waitForFunction(() => {
      const t = document.body?.innerText || '';
      return /order confirmed|thank you|order number|declined|refused/i.test(t);
    }, { timeout:30000 }).catch(()=>{});

    const bodyText = await page.evaluate(()=>document.body?.innerText||'');
    const productName = config.productUrl?.split('/').pop()?.replace(/-/g,' ').replace(/\b\w/g,c=>c.toUpperCase()) || 'Secret Lair';
    if (/order confirmed|thank you|order number/i.test(bodyText)) {
      console.log(`\n${_TPFX_C}${C.bold}${C.bg}  ✅  ORDER CONFIRMED!  ${C.r}\n`);
      appendFileSync(LOG_FILE, `[${ts()}] ORDER CONFIRMED!\n`);
      await sendWebhook({ success:true,  product:productName, qty, total:orderTotal, email:profile.email, webhook:config.webhook });
      return { result:'confirmed' };
    }
    console.log(`\n${_TPFX_C}${C.br}${C.bold}  ❌  Payment declined/refused${C.r}\n`);
    appendFileSync(LOG_FILE, `[${ts()}] Payment declined/refused\n`);
    await sendWebhook({ success:false, product:productName, qty, total:orderTotal, email:profile.email, webhook:config.webhook });
    return { result:'declined' };

  } catch(err) {
    logErr(`FAILED at: ${err.message}`);
    try { await screenshot(page, 'FATAL-ERROR'); } catch {}
    if (HEADED) {
      log('  [headed] Error — browser staying open for manual override. Close window when done.');
    } else {
      throw err;
    }
  } finally {
    // Save cookies so next run starts with an established session
    if (profile.email) await saveCookies(profile.email, context).catch(() => {});
    if (HEADED) {
      // In headed mode, keep the browser open so the user can take over.
      // HAR flushes when the user closes the window (browser disconnect).
      log(`  [headed] Browser open — close the window when done. HAR flushes on close → ${path.join("logs", `har-${RUN_TS}.har`)}`);
      await new Promise(resolve => {
        if (!browser.isConnected()) return resolve();
        browser.once('disconnected', resolve);
      });
    } else {
      // Close the context first — this flushes the HAR file to disk — then the browser.
      await context.close().catch(() => {});
      log(`  HAR saved → ${path.join("logs", `har-${RUN_TS}.har`)}`);
      await browser.close().catch(() => {});
    }
  }
}

// ─── Profile normalizer ───────────────────────────────────────────────────────
// Accepts both the new format (shipping/payment sub-objects) and the old flat format
function normalizeProfile(p) {
  const month = String(p.payment?.cardMonth || '').padStart(2, '0');
  const year  = String(p.payment?.cardYear  || '').slice(-2).padStart(2, '0');
  return {
    email:     p.email,
    phone:     p.phone,
    firstName: p.shipping?.firstName ?? p.firstName,
    lastName:  p.shipping?.lastName  ?? p.lastName,
    address1:  p.shipping?.address   ?? p.address1,
    address2:  p.shipping?.address2  ?? p.address2 ?? '',
    city:      p.shipping?.city      ?? p.city,
    state:     p.shipping?.state     ?? p.state,
    zip:       p.shipping?.zipcode   ?? p.zip,
    card: p.payment ? {
      number: p.payment.cardNumber,
      expiry: month + year,
      cvv:    p.payment.cardCvv,
      name:   p.payment.cardName,
    } : (p.card ?? null),
  };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────
if (process.argv.length > 2) {
  // Per-task config via --config=<path>: each task writes its OWN profile file so parallel tasks
  // never clobber each other. The shared secret-lair-profiles.json was last-write-wins — that's
  // why "main copy" ran the "test" profile. Falls back to the engine-local file for bare CLI runs.
  const cfgArg  = (process.argv.find(a => a.startsWith('--config=')) || '').slice('--config='.length);
  const cfgPath = cfgArg || new URL('./secret-lair-profiles.json', import.meta.url)
    .pathname.replace(/^\/([A-Z]:)/,'$1');
  const config   = JSON.parse(readFileSync(cfgPath,'utf8'));

  // Round-robin: thread N gets profile[(N-1) % profiles.length]
  const threadId   = parseInt(process.argv[3] || '1');
  const rawProfile = config.profiles[(threadId - 1) % config.profiles.length];
  const profile    = normalizeProfile(rawProfile);

  log(`Profile : ${rawProfile.profileName || profile.email}`);
  log(`Email   : ${profile.email}`);
  log(`Card    : ${profile.card ? `****${profile.card.number.slice(-4)}` : 'none'}`);
  log(`Proxies : ${PROXIES.length} loaded`);
  log('');

  const cliQty = parseInt(process.argv[4]) || 1;
  const overrideProductUrl = process.argv.find(a => a.startsWith('--product-url='))?.slice('--product-url='.length);
  if (overrideProductUrl) config.productUrl = overrideProductUrl;
  runBrowserlessCheckout(process.argv[2], profile, config, cliQty)
    .catch(e => { console.error('FAILED:', e.message); process.exit(1); });
}
