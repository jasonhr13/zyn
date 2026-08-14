// Target.com account signup bot — ported from the user's own hard-won reference implementation
// at Fable-Techniques/Fable-Generate/scrapers/target_signup_v2.py (~633 lines, read in full before
// writing this file). That Python file was "built empirically from live observation of
// target.com's current flow" (its own header comment) — NOT a guess, so every selector/URL/detail
// below that is grounded in an explicit Python constant or a concretely-executed line is flagged as
// CONFIRMED. A few things exist only in the Python file's prose docstring but are never actually
// driven by its code (e.g. an optional "#phone" field) — those are flagged as GUESS.
//
// Flow (mirrors target_signup_v2.py's _drive()):
//   1. Warm the session on the homepage (mouse/scroll simulation) to accumulate PerimeterX cookies
//      BEFORE hitting /account/signup — the Python source's own comments say a cold hit is more
//      likely to get risk-scored.
//   2. Navigate to /account/signup, type the email into #username, click #login ("Continue").
//   3. Continue leads to one of three states: the create-account form mounts (fresh email), a bare
//      password field appears with no #firstname (email already has an account), or a PerimeterX
//      block/challenge shows up.
//   4. Fill #firstname/#lastname, click the "use password instead of passkey" radio label, fill
//      #password.
//   5. Click #createAccount.
//   6. The ONLY authoritative "account created" signal is an HTTP 201 on the network response for
//      POST .../gsp/authentications/v2/accounts (its body carries a targetGuid) — NOT any DOM text,
//      NOT a URL change. This script wires a response listener for that exact call, mirroring the
//      Python source's own header comment about why: everything else (banners, redirects) can lag,
//      race, or lie, but that POST's status code cannot.
//
// CRITICAL — same class of bug pbandai-register.mjs's Step 10 comment warns about, applied here in
// its OWN specific way: Target's flow has NO multi-step "wizard" with a reused label, but it DOES
// have several visually-similar dead ends (an email-OTP gate, a "such email already registered"
// bounce) that must NOT be confused with success. This script treats success as ONLY the 201 on
// /v2/accounts, exactly like the Python source's "_account_created" flag — never a generic "form
// submitted" or "no error shown" inference.
//
// NOTABLE BOT-DETECTION FACTS FROM THE PYTHON SOURCE (see its own header comment, ported verbatim
// in spirit): fresh Gmail addresses tend to trip an email-OTP risk gate (200 response with
// actions:[additional_factor_required]) that "usually dead-ends" — catchall/custom-domain or
// iCloud addresses tend to get a clean 201 instead. Datacenter proxies get hard-blocked (401
// _ERR_AUTH_DENIED); residential proxies get through. A PerimeterX press-and-hold challenge can
// appear at either the post-email-Continue step or after the final submit.

import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchAuthCode } from './imap-client.mjs';
import { fetchAuthCodeViaAycd } from './aycd-mail-client.mjs';
import { argOf, FIRST_NAMES, LAST_NAMES, pick, randomAdultDob, sleep, randomDelay, createBotContext, sendAccountCreatedWebhook } from './shared.mjs';
import { generationLaunchOptions } from './generation-browsers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Selectors/URLs — CONFIRMED: copied directly from target_signup_v2.py's own module-level
// constants (EMAIL_INPUT, CONTINUE_BTN, FIRST_INPUT, LAST_INPUT, PASSWORD_RADIO_LABEL,
// PASSWORD_INPUT, CREATE_BTN, HOME_URL, SIGNUP_URL, ACCOUNTS_EP, BLOCK_HINTS) — this is the highest
// confidence tier available since these are literal strings the Python bot actually drove against
// the live site, not something inferred from prose. Still translated from a different browser
// engine (patchright/CDP) to Playwright, so "confirmed" means "confirmed against Python's source,
// not yet live-verified against the DOM through Playwright" — treat a failure here as the first
// place to dumpHtml and look.
const EMAIL_INPUT = '#username';
const CONTINUE_BTN = '#login';
const FIRST_INPUT = '#firstname';
const LAST_INPUT = '#lastname';
const PASSWORD_RADIO_LABEL = "label[for='password-checkbox']";
const PASSWORD_INPUT = '#password';
const CREATE_BTN = '#createAccount';
const HOME_URL = 'https://www.target.com/';
const SIGNUP_URL = 'https://www.target.com/account/signup';
const ACCOUNTS_POST_PATH = '/v2/accounts'; // POST .../gsp/authentications/v2/accounts — the 201 is the only real success signal

// ── Target Circle. GUESS tier: target_signup_v2.py stops dead at the 201 and never touches Circle,
// so there is no ground truth to port — these come from the post-signup screenshot of the real
// interstitial ("Join for free to save even more", an OPTIONAL "Birthday (MM/DD)" input, and three
// buttons: "Join for free!", "Don't join", "Maybe later").
//
// Target's own internal codename for Circle is "trident": the 201 body comes back as
//   {"username":…,"targetGuid":…,"actions":["show_trident_dont_join"],"firstName":…}
// which is the server telling the client to render this exact sheet. That's why CIRCLE_URL_HINT
// matches on it — it's the string Target itself uses, not one we invented.
// Target ships a stable test id on this button — confirmed from a live run's call log:
//   <button id="EnrollmentJoinForFreeButton" data-test="EnrollmentJoinForFreeButton" ...>
// Prefer it over matching the label, which breaks on copy changes ("Join for free!" vs
// "Join for free") and on any non-English locale. Text stays as a last-resort fallback.
const CIRCLE_JOIN_BTN = '[data-test="EnrollmentJoinForFreeButton"], #EnrollmentJoinForFreeButton, '
  + 'button:has-text("Join for free"), [role="button"]:has-text("Join for free")';
const CIRCLE_BIRTHDAY_INPUT = 'input[placeholder*="birthday" i]';
const CIRCLE_URL_HINT = /(trident|circle|loyalt)/i;

// CONFIRMED — verbatim from BLOCK_HINTS / the OTP-gate text checks in target_signup_v2.py's
// _page_blocked / _otp_gate_present.
const BLOCK_HINTS = ['something went wrong on our end', 'access denied', '/blocked', 'reference #', 'unusual activity'];
const OTP_HINTS = ['enter the code', 'verification code', 'we sent a code', 'one-time'];

// CONFIRMED — verbatim from the Python source's _DEVICES list and _STEALTH_JS init script (the
// hardwareConcurrency/deviceMemory spoof it installs before any navigation to avoid a static
// host-device fingerprint cluster). Ported to a plain Playwright addInitScript() call since
// Playwright supports the same init-script mechanism the Python source used via patchright.
const DEVICES = [
  { hwc: 4, dmem: 8 }, { hwc: 8, dmem: 8 }, { hwc: 6, dmem: 8 }, { hwc: 8, dmem: 4 },
  { hwc: 12, dmem: 8 }, { hwc: 16, dmem: 8 }, { hwc: 4, dmem: 4 }, { hwc: 10, dmem: 8 },
];

function stealthInitScript(hwc, dmem) {
  return `(function(){
  var HWC = ${hwc}, DMEM = ${dmem};
  function nativeGetter(name, value){
    var fn = function(){ return value; };
    try { Object.defineProperty(fn, 'name', {value: 'get ' + name, configurable: true}); } catch(e){}
    var ts = function(){ return 'function get ' + name + '() { [native code] }'; };
    try { Object.defineProperty(ts, 'toString', {value: function(){ return 'function toString() { [native code] }'; }, configurable: true}); } catch(e){}
    try { Object.defineProperty(fn, 'toString', {value: ts, writable: false, configurable: true}); } catch(e){}
    return fn;
  }
  function spoof(target, name, value){
    if (!target) return;
    try { delete target[name]; } catch(e){}
    try {
      Object.defineProperty(target, name, {get: nativeGetter(name, value), set: function(){}, configurable: true, enumerable: true});
      return;
    } catch(e){}
    try { Object.defineProperty(target, name, {value: value, writable: false, configurable: true, enumerable: true}); } catch(e){}
  }
  var protoNav = Object.getPrototypeOf(navigator) || (window.Navigator && Navigator.prototype);
  spoof(protoNav, 'hardwareConcurrency', HWC); spoof(navigator, 'hardwareConcurrency', HWC);
  spoof(protoNav, 'deviceMemory', DMEM);       spoof(navigator, 'deviceMemory', DMEM);
})();`;
}

const CONFIG = {
  url: SIGNUP_URL,
  homeUrl: HOME_URL,
  email: argOf('email', ''),
  firstName: argOf('firstName', '') || pick(FIRST_NAMES),
  lastName: argOf('lastName', '') || pick(LAST_NAMES),
  // Target's own password complexity rules are NOT shown anywhere in target_signup_v2.py (it just
  // types whatever string it's given), so this default is an UNVERIFIED guess at "probably strong
  // enough" — reusing pbandai's known-safe default (no 3-char ascending run) as a starting point.
  password: argOf('password', 'Bx9!Lq4tRz'),
  // Target Circle enrolment (Step 7). ON by default: these accounts exist to buy with, and Circle
  // is free, instant and gates member-only pricing/offers on drops — there's no downside to being
  // enrolled. Pass --joinCircle=0 to skip it. NEVER fatal: see joinTargetCircle()'s comment.
  joinCircle: argOf('joinCircle', '1') !== '0',
  // Target Circle can optionally ask for a birthday after account creation.
  dateOfBirth: argOf('dob', '') || randomAdultDob(),
  // Used ONLY as a best-effort recovery if Target's email-OTP gate appears (Step 6 below) — see the
  // KNOWN LIMITATION comment there. target_signup_v2.py itself does NOT solve this gate; it treats
  // it as a dead end and expects the caller to retry with a different email address type.
  aycdApiKey: argOf('aycdApiKey', ''), // both can be set at once — see attemptEmailOtpRecovery's AYCD-then-IMAP fallback
  imapHost: argOf('imapHost', 'imap.gmail.com'),
  imapPort: parseInt(argOf('imapPort', '993')),
  imapUser: argOf('imapUser', ''),
  imapPass: argOf('imapPass', ''),
  // Proxy — per the Python source's own header comment this is NOT cosmetic here: residential
  // proxies got a clean 201, datacenter proxies got hard-blocked with a 401 _ERR_AUTH_DENIED. A bad
  // proxy is a likely cause of failure independent of anything this script does.
  proxyServer: argOf('proxyServer', ''),
  proxyUser: argOf('proxyUser', ''),
  proxyPass: argOf('proxyPass', ''),
  // Local-IP runs require an explicit CLI override; Zyn's UI requires a proxy list for Target.
  allowLocal: argOf('allowLocal', '0') === '1',
  webhook: argOf('webhook', ''),
  browser: argOf('browser', 'auto'),
};

const SIGNUP_ID = argOf('id', 'default');
const DATA_DIR = argOf('data-dir', __dirname);
const { shotsDir, log, logDebug, shot, dumpHtml, logPageState, tryClick, humanType } =
  createBotContext({ dataDir: DATA_DIR, botName: 'target', signupId: SIGNUP_ID });

async function pageBlocked(page) {
  try {
    const txt = (await page.evaluate(() => (document.body.innerText || '').toLowerCase())).slice(0, 2000);
    return BLOCK_HINTS.some(h => txt.includes(h));
  } catch { return false; }
}

async function otpGatePresent(page) {
  try {
    const txt = (await page.evaluate(() => (document.body.innerText || '').toLowerCase())).slice(0, 1500);
    return OTP_HINTS.some(h => txt.includes(h));
  } catch { return false; }
}

// CONFIRMED — verbatim from _px_present() in target_signup_v2.py.
async function pxPresent(page) {
  try {
    return await page.evaluate(() => !!(
      document.querySelector('#px-captcha') ||
      document.querySelector('iframe[src*="px-cloud"]') ||
      document.querySelector('iframe[src*="captcha"]') ||
      [...document.querySelectorAll('*')].some(e => /press\s*&?\s*hold/i.test(e.textContent || ''))
    ));
  } catch { return false; }
}

// CONFIRMED (logic) — ported from _handle_px(): a 3-attempt press-and-hold (8-12s each, with small
// jitter while held) on whatever PX challenge element is found. Coordinates/selector matching are
// the same as the Python source; only the Python-specific page.evaluate getBoundingClientRect glue
// is kept as-is rather than swapped for Playwright's elementHandle.boundingBox(), to stay a direct
// translation of logic that's known to have worked live.
async function handlePx(page) {
  if (!(await pxPresent(page))) return false;
  log('  ⚠ PerimeterX challenge detected — attempting press-and-hold solve...');
  try {
    const box = await page.evaluate(() => {
      const el = document.querySelector('#px-captcha')
        || document.querySelector('iframe[src*="px-cloud"]')
        || document.querySelector('iframe[src*="captcha"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (!box) { log('  ✗ PX challenge element not locatable for coordinates'); return false; }
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.mouse.move(box.x, box.y, { steps: 15 });
      await page.mouse.down();
      const holdMs = randomDelay(8000, 12000);
      const tEnd = Date.now() + holdMs;
      while (Date.now() < tEnd) {
        await page.mouse.move(box.x + (Math.random() * 2 - 1), box.y + (Math.random() * 2 - 1), { steps: 2 });
        await sleep(300);
      }
      await page.mouse.up();
      await sleep(randomDelay(2000, 3000));
      if (!(await pxPresent(page))) {
        log('  ✓ PerimeterX challenge cleared');
        return true;
      }
    }
    log('  ✗ PerimeterX challenge NOT cleared after 3 attempts');
    return false;
  } catch (e) {
    log(`  PX solve error: ${e.message}`);
    return false;
  }
}

// CONFIRMED (logic) — ported from _await_post_continue(): after clicking Continue, poll for which
// of three states we landed in. `getAccountCreated`/`getUvActions` are closures over the response
// listener's state (see Step 2 in main()).
async function awaitPostContinue(page, getAccountCreated, getUvActions, timeoutMs = 18000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (getAccountCreated()) return 'create';
    try {
      const createBtnCount = await page.locator(CREATE_BTN).count();
      const firstInputCount = await page.locator(FIRST_INPUT).count();
      if (createBtnCount > 0 || firstInputCount > 0) return 'create';
    } catch {}
    if (await pageBlocked(page)) return 'block';
    try {
      const pwVisible = await page.locator("input[type='password']").first().isVisible().catch(() => false);
      const firstInputCount2 = await page.locator(FIRST_INPUT).count();
      if (pwVisible && firstInputCount2 === 0) return 'exists';
    } catch {}
    const uv = (getUvActions() || '').toLowerCase();
    if (uv && !uv.includes('create_account') && ['password', 'signin', 'sign_in'].some(k => uv.includes(k))) {
      return 'exists';
    }
    await sleep(500);
  }
  return 'timeout';
}

async function main() {
  if (!CONFIG.email) {
    log('ERROR: --email required');
    process.exit(1);
  }
  if (!CONFIG.password) {
    log('ERROR: --password required');
    process.exit(1);
  }

  log('═══════════════════════════════════════════');
  log('Target Account Generator');
  log(`Email: ${CONFIG.email}`);
  log(`Name: ${CONFIG.firstName} ${CONFIG.lastName}`);
  log('═══════════════════════════════════════════');

  const launchBase = {
    // Target signup fails in New Headless. Generation always uses a real headed window.
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  };

  if (CONFIG.proxyServer) {
    launchBase.proxy = { server: CONFIG.proxyServer };
    if (CONFIG.proxyUser && CONFIG.proxyPass) {
      launchBase.proxy.username = CONFIG.proxyUser;
      launchBase.proxy.password = CONFIG.proxyPass;
    }
  } else if (!CONFIG.allowLocal) {
    throw new Error('Target generation requires --proxyServer (pass --allowLocal=1 only for an intentional local-IP run)');
  } else {
    log('  ⚠ Running on the local IP by explicit request; Target may risk-block this session.');
  }

  const harFile = path.join(shotsDir, 'network.har');
  log(`HAR capture: ${harFile} (written on close — full request/response log for debugging)`);

  const { browser: selectedBrowser, launchOptions } = await generationLaunchOptions(CONFIG.browser, launchBase);
  log(`Launching headed ${selectedBrowser.label} (${selectedBrowser.key})`);
  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({ recordHar: { path: harFile, mode: 'full' } });
  const page = await context.newPage();

  // Stealth device spoof — must be installed before ANY navigation (see CONFIRMED comment above).
  const device = pick(DEVICES);
  await page.addInitScript(stealthInitScript(device.hwc, device.dmem));
  log(`Stealth device spoof: hardwareConcurrency=${device.hwc} deviceMemory=${device.dmem}`);

  // Response listener — this IS the success detector. Wired before any navigation so it can never
  // miss the POST even if it fires unexpectedly early or late relative to where we think we are in
  // the flow. CONFIRMED logic, ported from _wire_sniffer()'s on_resp handler.
  let accountCreated = false;
  let submitStatus = null;
  let submitBody = null;
  let uvActions = null;
  // Circle enrolment result. We do NOT know Target's enrolment endpoint (see CIRCLE_URL_HINT), so
  // rather than assert one, record whatever POST the Join click actually produces and log it. That
  // makes the first real run self-documenting: the DEBUG line names the endpoint for next time.
  let circleStatus = null;
  let circleUrl = null;

  page.on('response', async (resp) => {
    try {
      const u = resp.url();
      if (!u.includes('target.com') && !u.includes('px-cloud')) return;
      if (u.includes(ACCOUNTS_POST_PATH) && resp.request().method() === 'POST') {
        submitStatus = resp.status();
        try { submitBody = (await resp.text()).slice(0, 600); } catch {}
        logDebug('accounts_post_response', { status: submitStatus, body: submitBody });
        if (submitStatus === 201) {
          accountCreated = true;
          log('  *** 201 on POST /v2/accounts — ACCOUNT CREATED (authoritative signal) ***');
        }
      } else if (u.includes('username_validations')) {
        try { uvActions = (await resp.text()).slice(0, 300); } catch {}
      } else if (CIRCLE_URL_HINT.test(u) && resp.request().method() === 'POST') {
        circleStatus = resp.status();
        circleUrl = u;
        logDebug('circle_post_response', { url: u, status: circleStatus });
      }
    } catch {}
  });

  try {
    // Step 1: Warm the session on the homepage — mouse/scroll simulation to accumulate PerimeterX
    // cookies (_px3/_pxhd/pxcts/_pxvid) before ever hitting /account/signup. CONFIRMED logic,
    // ported from _drive()'s warm-up loop (18s deadline, break early once a px cookie is seen).
    log('Step 1: Warming session on target.com homepage...');
    try {
      await page.goto(CONFIG.homeUrl, { waitUntil: 'commit', timeout: 12000 });
      await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    } catch (e) {
      log(`  ⚠ Warm-up navigation failed: ${e.message} — proxy may be dead/slow; continuing anyway`);
    }

    const warmDeadline = Date.now() + 18000;
    let pxSeen = false;
    while (Date.now() < warmDeadline) {
      try {
        await page.mouse.move(200 + Math.random() * 900, 150 + Math.random() * 550, { steps: 8 + Math.floor(Math.random() * 10) });
        await page.mouse.wheel(0, 250 + Math.random() * 400);
      } catch {}
      await sleep(randomDelay(1200, 2000));
      try {
        const names = (await context.cookies()).map(c => c.name);
        if (names.some(n => ['_px3', '_pxhd', 'pxcts', '_pxvid'].includes(n))) { pxSeen = true; break; }
      } catch {}
    }
    log(`  Warm-up done (px cookie seen: ${pxSeen})`);
    await shot(page, '01-warmed-home');

    // Step 2: Navigate to signup, enter email, click Continue.
    log('Step 2: Navigating to Target signup page...');
    try {
      await page.goto(CONFIG.url, { waitUntil: 'commit', timeout: 12000 });
      await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    } catch (e) {
      log(`  ⚠ Signup navigation failed: ${e.message}`);
    }
    await logPageState(page, 'After navigate to signup');
    await shot(page, '02-signup-page');

    log('  Entering email...');
    const emailFilled = await humanType(page, 'Email input', EMAIL_INPUT, CONFIG.email, { timeout: 30000 });
    if (!emailFilled) {
      const blocked = await pageBlocked(page);
      log(`✗ FAILED: email input never mounted (${blocked ? 'page shows block copy — likely proxy/PX block' : 'selector may have drifted, or page still loading'})`);
      await dumpHtml(page, '02-email-not-found');
      await shot(page, '02-email-not-found');
      process.exit(1);
    }
    await sleep(randomDelay(400, 800));
    await tryClick(page, 'Continue button', CONTINUE_BTN, { timeout: 5000, settle: 500 });

    // Step 3: See what Continue produced.
    log('Step 3: Waiting to see where Continue took us (create form / already-exists / PX block)...');
    let reached = await awaitPostContinue(page, () => accountCreated, () => uvActions);
    if (reached === 'block') {
      log('  PerimeterX block/challenge detected after Continue — attempting solve...');
      await handlePx(page);
      reached = await awaitPostContinue(page, () => accountCreated, () => uvActions);
    }
    if (reached === 'exists') {
      log(`✗ FAILED: ${CONFIG.email} already has a Target account — nothing to create this run.`);
      await dumpHtml(page, '03-already-exists');
      await shot(page, '03-already-exists');
      process.exit(1);
    }
    if (reached !== 'create') {
      log(`✗ FAILED: did not reach the create-account form (state: ${reached}) — check the HTML dump for what page we actually landed on.`);
      await dumpHtml(page, '03-unreached');
      await shot(page, '03-unreached');
      process.exit(1);
    }
    log('  ✓ Reached create-account form');
    await shot(page, '03-create-form');

    // Step 4: Fill the confirmed create-account fields. Target signup does not use SMS or a
    // shipping address; Circle birthday is handled separately after the authoritative 201.
    log('Step 4: Filling create-account form...');
    await logPageState(page, 'Before form fill');
    await humanType(page, 'First name', FIRST_INPUT, CONFIG.firstName);
    await humanType(page, 'Last name', LAST_INPUT, CONFIG.lastName);

    await tryClick(page, 'Switch to password auth (radio label)', PASSWORD_RADIO_LABEL, { timeout: 5000, settle: 500 });
    const passwordAppeared = await page.locator(PASSWORD_INPUT).first().isVisible({ timeout: 8000 }).catch(() => false);
    if (!passwordAppeared) {
      log('✗ FAILED: password field never appeared after switching off passkey — form structure may have changed.');
      await dumpHtml(page, '04-no-password-field');
      await shot(page, '04-no-password-field');
      process.exit(1);
    }
    await sleep(randomDelay(300, 600));
    await humanType(page, 'Password', PASSWORD_INPUT, CONFIG.password);
    await dumpHtml(page, '04-form-filled');
    await shot(page, '04-form-filled');

    // Step 5: Submit.
    log('Step 5: Submitting create-account form...');
    await sleep(randomDelay(600, 1200));
    await tryClick(page, 'Create account button', CREATE_BTN, { timeout: 5000, settle: 0 });
    await shot(page, '05-submitted');

    // Step 6: Poll for the authoritative 201 on POST /v2/accounts, handling PX challenges and the
    // email-OTP gate as they appear. CONFIRMED poll structure (25s window, extended on a PX
    // encounter, 540s hard ceiling) ported from _drive()'s post-submit loop.
    log('Step 6: Waiting for POST /v2/accounts response (the ONLY authoritative success signal)...');
    const overallDeadline = Date.now() + 540000;
    let pollDeadline = Date.now() + 25000;
    let otpAttempted = false;

    while (Date.now() < overallDeadline && Date.now() < pollDeadline) {
      if (accountCreated) break;
      if (await pxPresent(page)) {
        await handlePx(page);
        pollDeadline = Date.now() + 20000;
      }
      if (!accountCreated && !otpAttempted && await otpGatePresent(page)) {
        otpAttempted = true;
        await attemptEmailOtpRecovery(page);
        pollDeadline = Date.now() + 20000;
      }
      await sleep(500);
    }

    // Step 7: Final success/failure determination.
    if (accountCreated) {
      log('✓ SUCCESS! Account created (authoritative 201 on POST /v2/accounts)!');
      logDebug('account_created', { email: CONFIG.email, status: submitStatus });
      await logPageState(page, 'Success');
      await shot(page, '99-success');

      // Step 7 runs AFTER the account is already banked as a success, and is wrapped so that even
      // an unexpected throw cannot downgrade a created account into a reported failure.
      if (CONFIG.joinCircle) {
        await joinTargetCircle().catch(e => log(`  ⚠ Circle join errored — account is still created: ${e.message}`));
      }

      await sendAccountCreatedWebhook({ webhookUrl: CONFIG.webhook, siteName: 'Target', email: CONFIG.email, password: CONFIG.password });
      process.exit(0);
    }

    await logPageState(page, 'Final state (no 201 seen)');
    const bodyLower = (submitBody || '').toLowerCase();
    let reason;
    if (bodyLower.includes('additional_factor')) {
      reason = 'email_otp_gate: Target demanded an email OTP (per the Python source, try a catchall/custom-domain or iCloud email instead of a fresh gmail address)';
    } else if ([401, 403].includes(submitStatus) || bodyLower.includes('errorcode') || bodyLower.includes('_err_')) {
      reason = `proxy blocked: POST /v2/accounts -> ${submitStatus} ${(submitBody || '').slice(0, 90)}`;
    } else if (await otpGatePresent(page)) {
      reason = 'email_otp_gate (OTP screen shown, no additional_factor body match)';
    } else if (submitStatus === null) {
      reason = 'submit produced no POST /v2/accounts call at all (form/flow issue — check the dumped HTML)';
    } else {
      reason = `no 201 after submit (status=${submitStatus})`;
    }
    log(`✗ FAILED: ${reason}`);
    logDebug('signup_failed', { reason, submitStatus, submitBody });
    await dumpHtml(page, '99-failed');
    await shot(page, '99-failed');
    process.exit(1);

  } catch (e) {
    logDebug('signup_error', { error: e.message, stack: e.stack });
    // CONFIRMED behavior — mirrors the Python source's own "post-201 exception (salvaged)" path:
    // once the 201 has actually been seen, the account IS created no matter what breaks afterward
    // (a hung page, a teardown error, etc.) — don't report a real success as a failure.
    if (accountCreated) {
      log(`  (exception after 201 was already seen — salvaging as SUCCESS: ${e.message})`);
      logDebug('account_created', { email: CONFIG.email, status: submitStatus, salvaged: true });
      await sendAccountCreatedWebhook({ webhookUrl: CONFIG.webhook, siteName: 'Target', email: CONFIG.email, password: CONFIG.password }).catch(() => {});
      await shot(page, '99-success-salvaged').catch(() => {});
      process.exit(0);
    }
    log(`✗ FAILED: ${e.message}`);
    await logPageState(page, 'Final state (error)').catch(() => {});
    await dumpHtml(page, '99-error');
    await shot(page, '99-error');
    process.exit(1);
  } finally {
    await context.close();
    await browser.close();
    log(`HAR written: ${harFile}`);
  }

  // Step 7 — enrol the new account in Target Circle.
  //
  // ALWAYS BEST-EFFORT, NEVER FATAL. By the time this runs the 201 has already proved the account
  // exists, so every path here returns rather than throwing or exiting: a Circle failure must not
  // cost us an account we successfully made. The caller reports success either way.
  //
  // Previously the script exited the instant it saw the 201, which is why runs ended on the Circle
  // sheet with its "Still loading…" modal still up — we were closing the browser on top of the
  // prompt rather than answering it.
  async function joinTargetCircle() {
    log('Step 7: Joining Target Circle (best-effort — the account is already created)...');
    const joinBtn = page.locator(CIRCLE_JOIN_BTN).first();

    // The sheet renders behind a "Still loading…" modal for a moment after the 201, so wait for
    // the button rather than probing for it once.
    const appeared = await joinBtn.waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false);
    if (!appeared) {
      log('  ⚠ Circle join prompt never appeared — skipping (Target only shows it when the 201 body');
      log('    carries a show_trident_* action, and it may already be enrolled or suppressed).');
      await shot(page, '07-circle-not-shown');
      return false;
    }
    await shot(page, '07-circle-prompt');

    // The sheet renders with a "Still loading…" modal over it, and that overlay swallows pointer
    // events: a real run spent its entire click budget on
    //   <div class="styles_overlay__AJMdo"> … intercepts pointer events / retrying click action
    // and never landed the click. Wait for it to clear FIRST rather than letting click() burn its
    // timeout retrying into it.
    //
    // Matched on the visible text, not the class: styles_overlay__AJMdo is a hashed CSS-module name
    // that changes on Target's next build, whereas the wording is what a human sees. Best-effort —
    // if it never resolves we still try the click, because the overlay sometimes stops intercepting
    // before it stops existing.
    const loadingOverlay = page.locator('text=/still loading/i').first();
    if (await loadingOverlay.isVisible().catch(() => false)) {
      log('  … "Still loading" overlay is up — waiting for it to clear before clicking');
      const cleared = await loadingOverlay.waitFor({ state: 'hidden', timeout: 20000 })
        .then(() => true).catch(() => false);
      log(cleared ? '  ✓ overlay cleared' : '  ⚠ overlay still up after 20s — trying the click anyway');
    }

    // The birthday field is genuinely OPTIONAL and only buys a yearly birthday coupon, so it is
    // never allowed to jeopardise the join: digits are typed into what is almost certainly an
    // auto-masking MM/DD input, then the resulting value is read back, and anything that doesn't
    // look like a clean MM/DD is cleared rather than submitted (a rejected birthday would block
    // the Join button, trading a real benefit for a cosmetic one).
    const bday = page.locator(CIRCLE_BIRTHDAY_INPUT).first();
    if (await bday.isVisible().catch(() => false)) {
      const [m, d] = String(CONFIG.dateOfBirth || '').split('/');
      if (m && d) {
        try {
          // Short, explicit timeouts: this field is optional and must never spend the step's
          // budget fighting the overlay. Playwright's default here is 30s.
          await bday.click({ timeout: 5000 });
          await bday.pressSequentially(`${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}`, { delay: 120 });
          const got = (await bday.inputValue().catch(() => '')) || '';
          if (/^\d{2}\/?\d{2}$/.test(got)) {
            log(`  ✓ Birthday: ${got}`);
          } else {
            log(`  ⚠ Birthday input produced "${got}" — not a clean MM/DD, clearing it and joining without one.`);
            await bday.fill('').catch(() => {});
          }
        } catch (e) {
          log(`  ⚠ Birthday fill failed (optional, continuing): ${e.message}`);
        }
      }
    }

    circleStatus = null;   // ignore anything seen before the click, so the check below is causal
    circleUrl = null;
    await sleep(randomDelay(400, 900));

    // click() auto-waits for the button to actually receive pointer events, so this is what rides
    // out the "Still loading…" overlay instead of clicking straight through it.
    try {
      await joinBtn.click({ timeout: 25000 });
      log('  ✓ "Join for free!" clicked');
    } catch (e) {
      log(`  ⚠ Could not click "Join for free!" (${e.message}) — account is still created.`);
      await shot(page, '07-circle-click-failed');
      return false;
    }

    // Wait for Target's own enrolment POST rather than trusting the button click. If none is seen
    // we fall back to "the prompt is gone", which is weaker but still better than assuming.
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && circleStatus === null) await sleep(300);

    if (circleStatus !== null) {
      const ok = circleStatus >= 200 && circleStatus < 300;
      log(`  ${ok ? '✓' : '⚠'} Circle enrolment POST -> ${circleStatus} (${circleUrl})`);
      logDebug('circle_join', { status: circleStatus, url: circleUrl, joined: ok });
      await shot(page, '07-circle-joined');
      return ok;
    }

    const gone = !(await joinBtn.isVisible().catch(() => false));
    log(`  ${gone ? '✓' : '⚠'} No Circle POST observed; prompt ${gone ? 'dismissed — treating as joined' : 'still on screen — join likely did not take'}.`);
    logDebug('circle_join', { status: null, joined: gone, inferredFrom: 'prompt-dismissed' });
    await shot(page, '07-circle-after');
    return gone;
  }

  // Best-effort email-OTP recovery — an ADDITION beyond what target_signup_v2.py itself does. The
  // Python source treats the OTP gate as a dead end BY DESIGN (its fix is "use a different email
  // type on the next attempt", not "solve this gate") — see its header comment. This is wired up
  // anyway per the porting brief's instruction to use fetchAuthCode when a site emails a code, but
  // it comes with a real, load-bearing limitation documented below.
  async function attemptEmailOtpRecovery(page) {
    log('  ⚠ Email OTP gate detected. The ported Python source does NOT solve this — it treats it as');
    log('    a dead end and expects a retry with a different email type (catchall/iCloud, not fresh');
    log('    gmail). Attempting best-effort IMAP recovery anyway since this app has that capability.');
    await dumpHtml(page, '06-otp-gate');
    await shot(page, '06-otp-gate');

    // Both providers can be configured at once — no forced choice; try AYCD Inbox first (its
    // fromFilter is per-call, not hardcoded, so it doesn't have the IMAP path's known limitation
    // below), then fall back to IMAP if AYCD fails or isn't configured.
    if (!CONFIG.aycdApiKey && !(CONFIG.imapUser && CONFIG.imapPass)) {
      log('  ✗ No email auth provider configured (--aycdApiKey or --imapUser/--imapPass) — cannot attempt OTP recovery.');
      return;
    }

    let found = null;
    if (CONFIG.aycdApiKey) {
      try {
        // REVERTED (2026-07-20): back to a short ~1min timeout — see the matching comment in
        // pbandai-register.mjs's Step 5 for why (some AYCD-connected mailboxes need OAuth2
        // re-login inside the Inbox app itself; a task against one of those never completes and
        // just times out no matter how long we wait, so a short timeout fails those fast instead
        // of blocking a worker slot for 10 minutes).
        found = await fetchAuthCodeViaAycd({ apiKey: CONFIG.aycdApiKey, targetEmail: CONFIG.email, fromFilter: 'target.com', codePattern: /(\d{4,8})/, timeoutMs: 60000 });
      } catch (e) {
        log(`  AYCD auth code fetch failed: ${e.message}${CONFIG.imapUser && CONFIG.imapPass ? ' — falling back to IMAP...' : ''}`);
      }
    }
    if (!found && CONFIG.imapUser && CONFIG.imapPass) {
      try {
        found = await fetchAuthCode({
          host: CONFIG.imapHost,
          port: CONFIG.imapPort,
          user: CONFIG.imapUser,
          password: CONFIG.imapPass,
        }, CONFIG.email, /(\d{4,8})/i, 60000, { onLog: log, fromFilter: 'target.com' });
      } catch (e) {
        log(`  IMAP auth code fetch failed: ${e.message}`);
      }
    }
    if (!found) {
      log('  ✗ Could not fetch auth code via any configured provider.');
      return;
    }

    try {
      log(`  ✓ Auth code found: ${found.code} (email To: ${found.matchedTo})`);

      // GUESS — unverified against a live Target OTP screen. target_signup_v2.py never solves this
      // gate, so there is no ground-truth selector in the source to port; this is a best-generic
      // guess only, flagged as such per the porting brief.
      const codeSelector = 'input[name*="code" i], input[placeholder*="code" i], #otp, input[autocomplete="one-time-code"]';
      const typed = await humanType(page, 'OTP code input (GUESS)', codeSelector, found.code, { timeout: 5000 });
      if (typed) {
        await tryClick(page, 'OTP submit/continue button (GUESS)', 'button:has-text("Continue"), button:has-text("Submit"), button:has-text("Verify")', { timeout: 4000, settle: 1000 });
      }
    } catch (e) {
      log(`  ✗ OTP recovery failed: ${e.message}`);
    }
  }
}

main().catch(e => {
  log(`FATAL: ${e.stack || e.message}`);
  process.exit(1);
});
