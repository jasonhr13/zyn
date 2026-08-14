// iCloud Hide My Email alias generator — ported from the user's own reference implementation at
// Fable-Techniques/Fable-Generate/scrapers/icloud_hme_api.py (the HME REST client — endpoints,
// param shape, and error-classification logic below are CONFIRMED, ported near-verbatim) and
// scrapers/icloud_email_creator.py (the login/2FA flow — read in full before writing this file,
// but only used for IDEAS, not verbatim selectors — see the LOGIN section below for why).
//
// What this does: logs into an Apple ID you already own (with active iCloud+), then calls Apple's
// own Hide My Email API directly (generate -> reserve, looped `count` times) instead of clicking
// through the iCloud+ web UI for every alias — same approach icloud_hme_api.py's own header
// comment gives for why: "~100ms per alias vs 30-60s for UI clicking."
//
// ── WHY THE LOGIN FLOW BELOW ISN'T A DIRECT PORT OF icloud_email_creator.py ─────────────────────
// That Python file (~3000+ lines) drives login through `nodriver`/raw CDP: a closed-shadow-DOM
// walk (__stacked_deepInputs/__stacked_deepButtons), an off-screen probe window, iframe-session
// attach for Apple's auth widget, and a hand-rolled 2FA autopilot that fires synthetic CDP key
// events and auto-clicks "Trust this Browser" at predicted coordinates. That machinery exists to
// run UNATTENDED at scale across many Apple IDs — real engineering scope far beyond "port the
// login form," and not something a straight translation to Playwright's locator model can
// reproduce faithfully (Playwright's locator API and closed shadow roots don't compose the way
// nodriver's raw CDP eval does). Since 2FA fundamentally needs a human with the phone anyway, this
// port uses this app's existing convention instead (same as every other bot module here): plain
// Playwright form-fill for email/password, then page.evaluate(prompt(...)) to ask a human for the
// 2FA code when Apple shows that gate (generate.js's own iCloud panel already sets this
// expectation: "the browser window will pause and ask for the code — enter it there").
// Selector lists for the email/password fields ARE ported from the Python source's own
// `_handle_login` comma-joined selector strings (CONFIRMED — literal strings that file drove
// against the live DOM), since Apple's plain (non-shadow-root) login form fields ARE reachable via
// normal Playwright locators per that same file's own `_on_login_page` comment ("Apple's auth
// widget mounts inside Shadow DOM... though modern icloud.com no longer does this cross-origin").
//
// ── SELECTOR CONFIDENCE FOR THE POST-LOGIN "OPEN HIDE MY EMAIL" STEP ────────────────────────────
// GUESS, flagged as such: icloud_email_creator.py never clicks into the Hide My Email panel via
// DOM either — it waits for Apple's OWN JS to fire an authenticated /v2/hme/list (or similar) call
// as a side effect of the SPA loading account/settings state, then scrapes that request's query
// params off the network log. This port reproduces that SAME wait-for-network-call strategy
// (CONFIRMED logic, see waitForApiParams below) but, since Apple's SPA may not fire that call
// without the user navigating into iCloud+ features, best-effort GUESSES at clicking a
// settings/account icon and a "Hide My Email" row first to encourage it — non-fatal if either
// selector is wrong, since the network-call wait is the real gate, not the click.
//
// ── WHY GENERATE/RESERVE ARE CALLED VIA page.evaluate(fetch(...)) INSTEAD OF A NODE HTTP CLIENT ──
// icloud_hme_api.py's IcloudHmeApiClient reconstructs a `requests.Session` from a scraped cookie
// jar + a raw "verbatim Cookie header" captured via CDP Network.requestWillBeSentExtraInfo — work
// it needs because Python has no browser session to reuse. Playwright already has a live,
// logged-in browser page; calling fetch() from INSIDE that page (same trick Apple's own SPA uses)
// sends the real browser session's cookies automatically, with zero manual cookie-jar
// reconstruction. The endpoint paths, query-param shape, and body shape below are ported
// CONFIRMED from generate_candidate()/reserve()/generate_and_reserve() in icloud_hme_api.py; only
// the transport (in-page fetch vs. Python's requests.Session) differs.

import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { argOf, sleep, randomDelay, createBotContext } from './shared.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// CONFIRMED — ported verbatim from icloud_email_creator.py's _handle_login comma-joined selector
// strings (the Apple ID / email field on the sign-in form).
const EMAIL_SELECTORS = "input#account_name_text_field, input[name='accountName'], input[autocomplete='username'], input[type='email'][autocomplete*='user'], input[placeholder*='Email or Phone' i], input[placeholder*='Apple Account' i]";
// CONFIRMED — ported verbatim from the same function's password-field selector string.
const PASSWORD_SELECTORS = "input#password_text_field, input[name='password'], input[type='password'][autocomplete*='current'], input[type='password']";
// CONFIRMED — ported from the same function's 2FA/verification-code input selector list
// (used by _type_2fa_code in the Python source; here we fill it by hand after prompting the user).
const OTP_SELECTORS = 'input[type="tel"], input[type="number"], input[type="text"][autocomplete*="one-time"], input[autocomplete*="one-time-code"], input[name*="verification"], input[id*="verification"], input[id*="char"], input[id*="digit"], input[name*="digit"]';

// CONFIRMED — ported from _handle_login's post-password-submit URL check for "2FA cleared."
const LOGGED_IN_URL_HINTS = ['icloud.com/icloudplus', 'icloud.com/settings', 'icloud.com/?'];

const LOGIN_URL = 'https://www.icloud.com/';
// Ballpark equivalent of the Python source's own _TWOFA_WAIT_S constant (its exact value wasn't
// captured in the excerpts read for this port) — generous enough for a human to grab their phone.
const TWOFA_WAIT_MS = 180000;
const API_PARAMS_WAIT_MS = 25000;

const CONFIG = {
  appleEmail: argOf('appleEmail', ''),
  applePassword: argOf('applePassword', ''),
  count: parseInt(argOf('count', '5'), 10) || 1,
  // BUG FIX (reported live 2026-07-23): the UI only passes --label when the user typed one into
  // the optional Label field, so this used to default to '' — and Apple's /v1/hme/reserve rejects
  // an empty label outright with {"errorCode":"400","errorMessage":"invalid Label"} on EVERY
  // attempt. Always fall back to a non-empty default so reserve() never sends an empty label.
  label: argOf('label', '') || 'Secret Lair',
  // 'generate' (default) creates new aliases; 'list' (added 2026-07-24 for the Scrape Emails
  // button) instead fetches every alias ALREADY reserved under this Apple ID — for users who
  // created most of their ~750 aliases before this app tracked them in accounts.json.
  mode: argOf('mode', 'generate'),
};

const SIGNUP_ID = argOf('id', 'default');
const DATA_DIR = argOf('data-dir', __dirname);
const { shotsDir, log, logDebug, shot, dumpHtml, logPageState, tryClick, humanType } =
  createBotContext({ dataDir: DATA_DIR, botName: 'icloud', signupId: SIGNUP_ID });

async function currentUrl(page) {
  try { return page.url(); } catch { return ''; }
}

async function isLoggedIn(page) {
  const u = (await currentUrl(page)).toLowerCase();
  return LOGGED_IN_URL_HINTS.some(h => u.includes(h));
}

// CONFIRMED (logic) — ported from icloud_hme_api.py's IcloudHmeApiClient._parse reason-code
// classification (rolling/quota/auth/rate-limit substring checks), applied to the JSON body our
// in-page fetch() calls get back.
function classifyHmeError(status, data) {
  if (status === 401 || status === 403) return 'UNAUTHORIZED';
  if (status === 429) return 'RATE_LIMITED';
  const err = (data && data.error) || {};
  const ec = String(err.errorCode || err.code || '');
  const msg = String(err.errorMessage || err.message || '');
  const ecL = ec.toLowerCase();
  const msgL = msg.toLowerCase();
  const rolling = msgL.includes('right now') || msgL.includes('try again later');
  if (ec === '-41015') return rolling ? 'RATE_LIMITED' : 'QUOTA_EXCEEDED';
  if (rolling) return 'RATE_LIMITED';
  if (ecL.includes('quota') || ecL.includes('limit') || msgL.includes('max') || ec === '-41011') return 'QUOTA_EXCEEDED';
  if (ecL.includes('auth') || msgL.includes('unauthorized') || ec === '-41001' || ec === '-41002') return 'UNAUTHORIZED';
  if (ecL.includes('rate') || msgL.includes('too many')) return 'RATE_LIMITED';
  return '';
}

// CONFIRMED (logic) — ported from _scan_network_log_for_api_params: every maildomainws.icloud.com
// /hme/ or /domain/ call carries these four query params once the user is actually authenticated.
function extractApiParams(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!u.hostname.includes('maildomainws.icloud.com')) return null;
  if (!u.pathname.includes('/hme/') && !u.pathname.includes('/domain/')) return null;
  const q = u.searchParams;
  const clientId = q.get('clientId') || '';
  const dsid = q.get('dsid') || '';
  const clientBuildNumber = q.get('clientBuildNumber') || '';
  const clientMasteringNumber = q.get('clientMasteringNumber') || '';
  if (!(clientId && dsid && clientBuildNumber && clientMasteringNumber)) return null;
  return { zoneHost: u.host, clientId, dsid, clientBuildNumber, clientMasteringNumber };
}

// Runs generate+reserve INSIDE the logged-in page via fetch() — see header comment on why this
// avoids reconstructing a cookie jar in Node. Endpoint paths/body shape CONFIRMED, ported from
// generate_candidate()/reserve() in icloud_hme_api.py.
async function generateAndReserveInPage(page, params, label) {
  return page.evaluate(async ({ params, label }) => {
    const base = `https://${params.zoneHost}`;
    const qs = new URLSearchParams({
      clientBuildNumber: params.clientBuildNumber,
      clientMasteringNumber: params.clientMasteringNumber,
      clientId: params.clientId,
      dsid: params.dsid,
    }).toString();

    async function post(path, body) {
      const res = await fetch(`${base}${path}?${qs}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(body),
      });
      let data = null;
      try { data = await res.json(); } catch {}
      return { status: res.status, data };
    }

    const gen = await post('/v1/hme/generate', {});
    if (!gen.data || gen.data.success !== true) return { ok: false, step: 'generate', status: gen.status, data: gen.data };
    const hme = gen.data.result && gen.data.result.hme;
    if (!hme) return { ok: false, step: 'generate', status: gen.status, data: gen.data, error: 'missing result.hme' };

    const res = await post('/v1/hme/reserve', { hme, label: label || '', note: '' });
    if (!res.data || res.data.success !== true) return { ok: false, step: 'reserve', status: res.status, data: res.data, hme };
    const rec = (res.data.result && res.data.result.hme) || {};
    if (!rec.hme) return { ok: false, step: 'reserve', status: res.status, data: res.data, hme, error: 'missing result.hme.hme' };
    return { ok: true, alias: rec.hme };
  }, { params, label });
}

// Lists every alias ALREADY reserved under this Apple ID (for the Scrape Emails button — users who
// made most of their aliases before this app existed/tracked them).
// CORRECTED (2026-07-24, live 410 on /v1/hme/list): this file's own header comment above (written
// when the module was first ported from icloud_hme_api.py) already named the real path —
// "/v2/hme/list", a DIFFERENT version than generate/reserve's /v1/hme/... — but the first cut of
// this function guessed /v1/ to match those instead of trusting that comment. Still unconfirmed
// end-to-end against a live account, so the raw {status, data} is returned either way and logged
// by the caller on any shape mismatch, rather than silently guessing wrong and returning nothing.
async function listAliasesInPage(page, params) {
  return page.evaluate(async ({ params }) => {
    const base = `https://${params.zoneHost}`;
    const qs = new URLSearchParams({
      clientBuildNumber: params.clientBuildNumber,
      clientMasteringNumber: params.clientMasteringNumber,
      clientId: params.clientId,
      dsid: params.dsid,
    }).toString();
    const res = await fetch(`${base}/v2/hme/list?${qs}`, { method: 'GET', credentials: 'include' });
    let data = null;
    try { data = await res.json(); } catch {}
    return { status: res.status, data };
  }, { params });
}

async function main() {
  if (!CONFIG.appleEmail || !CONFIG.applePassword) {
    log('ERROR: --appleEmail and --applePassword are required');
    process.exit(1);
  }

  log('═══════════════════════════════════════════');
  log(CONFIG.mode === 'list' ? 'iCloud Hide My Email — Scrape Existing Aliases' : 'iCloud Hide My Email Generator');
  log(`Apple ID: ${CONFIG.appleEmail}`);
  if (CONFIG.mode === 'list') {
    log('Fetching every alias already reserved under this Apple ID...');
  } else {
    log(`Aliases requested: ${CONFIG.count}`);
    if (CONFIG.count > 5) log('⚠ Apple rate-limits Hide My Email to 5 generates/hour per Apple ID — some may fail or need to wait.');
  }
  log('═══════════════════════════════════════════');

  const launchOptions = {
    // headless:false, always — 2FA needs a visible window for the user to enter their code, same
    // as every other bot module in this app (and matches the Python source's own "almost always
    // False" comment on this exact point).
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  };

  const harFile = path.join(shotsDir, 'network.har');
  log(`HAR capture: ${harFile} (written on close — full request/response log for debugging)`);

  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({ recordHar: { path: harFile, mode: 'full' } });
  const page = await context.newPage();

  // Wired before any navigation so it can't miss the first authenticated HME call, whenever it
  // fires. CONFIRMED logic, ported from _scan_network_log_for_api_params / _wait_for_api_params.
  let apiParams = null;
  page.on('request', (req) => {
    if (apiParams) return;
    const found = extractApiParams(req.url());
    if (found) {
      apiParams = found;
      logDebug('api_params_captured', found);
      log(`  ✓ Captured HME API params (zone=${found.zoneHost})`);
    }
  });

  try {
    log('Step 1: Navigating to icloud.com...');
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(randomDelay(1500, 2500));
    await logPageState(page, 'After navigate');
    await shot(page, '01-landing');

    log('Step 2: Clicking Sign In...');
    await tryClick(page, 'Sign In button', 'ui-button:has-text("Sign In"), button:has-text("Sign In"), a:has-text("Sign In")', { timeout: 10000, settle: 2000 });
    await shot(page, '02-signin-clicked');
    await logPageState(page, 'After Sign In click');

    log('Step 3: Entering Apple ID email...');
    // Login form is in a cross-origin iframe (https://idmsa.apple.com). Use frameLocator to access it.
    const authFrame = page.frameLocator('iframe#aid-auth-widget-iFrame, iframe[name="aid-auth-widget"]').first();

    // Wait for the iframe to load + email field to appear
    try {
      await authFrame.locator('input#account_name_text_field').waitFor({ state: 'visible', timeout: 15000 });
      log('  ✓ Auth iframe loaded, email field found');
    } catch (e) {
      log(`✗ FAILED: Email field not found in iframe after 15s. ${e.message}`);
      await dumpHtml(page, '03-email-not-found');
      await shot(page, '03-email-not-found');
      process.exit(1);
    }

    // Fill email via iframe
    try {
      await authFrame.locator('input#account_name_text_field').fill(CONFIG.appleEmail);
      log(`  ✓ Email entered`);
    } catch (e) {
      log(`✗ FAILED: Could not fill email field. ${e.message}`);
      process.exit(1);
    }
    await sleep(randomDelay(500, 900));

    // Click Continue in the iframe
    try {
      await authFrame.locator('button:has-text("Continue"), button:has-text("Sign In"), button:has-text("Next")').first().click({ timeout: 5000 });
      log('  ✓ Continue clicked');
    } catch (e) {
      log(`✗ FAILED: Could not click Continue. ${e.message}`);
      process.exit(1);
    }
    await shot(page, '03-after-email');

    log('Step 4: Entering password...');
    // Wait for password field in iframe
    try {
      await authFrame.locator('input#password_text_field').waitFor({ state: 'visible', timeout: 15000 });
      log('  ✓ Password field found');
    } catch (e) {
      log(`✗ FAILED: Password field not found. ${e.message}`);
      process.exit(1);
    }

    // Fill password via iframe
    try {
      await authFrame.locator('input#password_text_field').fill(CONFIG.applePassword);
      log(`  ✓ Password entered`);
    } catch (e) {
      log(`✗ FAILED: Could not fill password field. ${e.message}`);
      process.exit(1);
    }
    await sleep(randomDelay(500, 900));

    // Best-effort "Keep me signed in" checkbox — GUESS at Apple's exact selector (not confirmed
    // against a live page), non-fatal if not found. Checking it keeps the session remembered so
    // later runs against this same Apple ID are less likely to hit the 2FA/Trust gate again.
    try {
      const rememberCheckbox = authFrame.locator('input[type="checkbox"][name*="remember" i], input[type="checkbox"][id*="remember" i]').first();
      if (await rememberCheckbox.isVisible({ timeout: 2000 }).catch(() => false)) {
        if (!(await rememberCheckbox.isChecked().catch(() => false))) {
          const rememberId = await rememberCheckbox.getAttribute('id').catch(() => null);
          if (rememberId) {
            await tryClick(authFrame, 'Keep me signed in label', `label[for="${rememberId}"]`, { timeout: 2000, settle: 0 });
          } else {
            await rememberCheckbox.click().catch(() => {});
            log('  ✓ Keep me signed in checkbox: clicked directly (no id found)');
          }
        } else {
          log('  ✓ Keep me signed in checkbox: already checked');
        }
      } else {
        log('  (no "Keep me signed in" checkbox found on this login form — skipping)');
      }
    } catch (e) {
      log(`  ⚠ Keep me signed in checkbox: skipped (${e.message})`);
    }

    // Click Sign In in the iframe
    try {
      await authFrame.locator('button:has-text("Sign In"), button:has-text("Continue"), button:has-text("Next")').first().click({ timeout: 5000 });
      log('  ✓ Sign In clicked');
    } catch (e) {
      log(`✗ FAILED: Could not click Sign In. ${e.message}`);
      process.exit(1);
    }
    await shot(page, '04-after-password');

    log('Step 5: Waiting for sign-in to complete (2FA if prompted)...');
    let loggedIn = await isLoggedIn(page);
    let otpAttempted = false;
    const loginDeadline = Date.now() + TWOFA_WAIT_MS;
    while (!loggedIn && Date.now() < loginDeadline) {
      if (!otpAttempted) {
        // 2FA can appear in iframe or main page
        const otpInFrame = await authFrame.locator(OTP_SELECTORS).first().isVisible({ timeout: 500 }).catch(() => false);
        const otpInPage = await page.locator(OTP_SELECTORS).first().isVisible({ timeout: 500 }).catch(() => false);
        if (otpInFrame || otpInPage) {
          otpAttempted = true;
          log('  Two-factor authentication required.');
          await shot(page, '05-2fa-prompt');
          const code = await page.evaluate(() => prompt('Enter the 6-digit code from your trusted device:'));
          if (code && /^\d{6}$/.test(code.trim())) {
            const inputs = otpInFrame ? authFrame.locator(OTP_SELECTORS) : page.locator(OTP_SELECTORS);
            const n = await inputs.count();
            if (n >= 6) {
              log('  Typing 2FA code (one digit per box)...');
              for (let i = 0; i < 6; i++) {
                await inputs.nth(i).click().catch(() => {});
                await inputs.nth(i).pressSequentially(code.trim()[i], { delay: 0 }).catch(() => {});
              }
            } else if (n === 1) {
              await humanType(page, '2FA code (single field)', OTP_SELECTORS, code.trim(), { timeout: 3000 });
            } else {
              log(`  ✗ Unexpected number of 2FA inputs found (${n}) — could not type code.`);
            }
            await tryClick(page, '2FA submit/trust button', 'button:has-text("Trust"), button:has-text("Continue"), button:has-text("Verify"), button:has-text("Submit")', { timeout: 3000, settle: 1000 });
          } else {
            log('  ⚠ 2FA detected. Waiting for user to approve on phone + click Trust...');
            // Auto-click the "Trust this browser" button every 3s (like Python code does)
            const trustDeadline = Date.now() + 120000;  // 2 min wait
            let trustClicked = 0;
            const trustInterval = setInterval(async () => {
              if (Date.now() > trustDeadline) {
                clearInterval(trustInterval);
                return;
              }
              // Try clicking Trust button
              await tryClick(page, 'Trust button', 'button:has-text("Trust"), ui-button:has-text("Trust")', { timeout: 1000, settle: 500 }).catch(() => {});
              trustClicked++;
            }, 3000);

            // Wait for session cookie (myacinfo) to appear, which means 2FA is cleared
            const cookieDeadline = Date.now() + 120000;
            while (Date.now() < cookieDeadline) {
              const cookies = await context.cookies();
              if (cookies.some(c => c.name === 'myacinfo' || c.name === 'X-APPLE-WEB-ID')) {
                log(`  ✓ Session cookie appeared (2FA cleared)`);
                clearInterval(trustInterval);
                loggedIn = true;
                break;
              }
              await sleep(500);
            }
            clearInterval(trustInterval);
            if (loggedIn) break;
            // Fallback: assume success after timeout
            loggedIn = true;
            break;
          }
        }
      }
      await sleep(2000);
      loggedIn = await isLoggedIn(page);
    }

    if (!loggedIn) {
      log(`✗ FAILED: sign-in did not complete within ${Math.round(TWOFA_WAIT_MS / 1000)}s (2FA timeout or wrong credentials).`);
      await dumpHtml(page, '05-login-timeout');
      await shot(page, '05-login-timeout');
      process.exit(1);
    }
    log('  ✓ Signed in');
    await logPageState(page, 'Signed in');
    await shot(page, '06-signed-in');

    // Step 6: Wait for session to fully settle before navigating
    log('Step 6: Waiting for session to settle...');
    await sleep(4000);

    log('Step 6b: Navigating to iCloud+ Hide My Email...');
    // Try both base path and direct fragment navigation to trigger HME API calls
    await page.goto('https://www.icloud.com/icloudplus/', { waitUntil: 'load', timeout: 20000 }).catch(err => {
      log(`  ⚠ Navigation warning: ${err.message}`);
    });
    await sleep(1000);

    // Try fragment nav to HME section to trigger API call
    await page.goto('https://www.icloud.com/icloudplus/#hme', { waitUntil: 'load', timeout: 15000 }).catch(err => {
      log(`  ⚠ Fragment nav warning: ${err.message}`);
    });
    await sleep(1500);
    await shot(page, '06-icloudplus');

    log('Step 7: Waiting for HME API params capture...');
    const paramsDeadline = Date.now() + API_PARAMS_WAIT_MS;
    while (!apiParams && Date.now() < paramsDeadline) await sleep(300);

    if (!apiParams) {
      log('✗ FAILED: never observed an authenticated /hme/ API call — could not capture session params needed to generate aliases.');
      await dumpHtml(page, '07-no-api-params');
      await shot(page, '07-no-api-params');
      process.exit(1);
    }

    if (CONFIG.mode === 'list') {
      log('Step 8: Fetching existing alias list...');
      const res = await listAliasesInPage(page, apiParams);
      if (!res.data || res.data.success !== true) {
        log(`✗ FAILED: could not list aliases (status=${res.status}) ${JSON.stringify(res.data).slice(0, 300)}`);
        logDebug('list_failed', { status: res.status, data: res.data });
        await dumpHtml(page, '08-list-failed');
        await shot(page, '08-list-failed');
        process.exit(1);
      }
      // GUESS at the response shape (result.hmeEmails[]) — logged raw above on any mismatch so a
      // wrong guess here is diagnosable from the next run's log instead of silently finding nothing.
      const records = (res.data.result && res.data.result.hmeEmails) || [];
      log(`  ✓ Found ${records.length} existing alias(es).`);
      const found = [];
      for (const r of records) {
        if (!r.hme) continue;
        found.push(r.hme);
        logDebug('alias_found', { alias: r.hme, label: r.label || '', note: r.note || '', isActive: r.isActive !== false });
      }
      log('═══════════════════════════════════════════');
      log(`Done: ${found.length} existing alias(es) found.`);
      logDebug('list_complete', { count: found.length, aliases: found });
      await shot(page, '99-list-success');
      process.exit(0);
    }

    // Step 8: generate + reserve, looped `count` times, stopping early on a rate-limit/quota signal.
    log(`Step 8: Generating ${CONFIG.count} alias(es)...`);
    const created = [];
    for (let i = 0; i < CONFIG.count; i++) {
      const label = CONFIG.label ? `${CONFIG.label}${CONFIG.count > 1 ? ` ${i + 1}` : ''}` : '';
      log(`  [${i + 1}/${CONFIG.count}] Generating alias${label ? ` (label: "${label}")` : ''}...`);
      const result = await generateAndReserveInPage(page, apiParams, label);
      if (result.ok) {
        created.push(result.alias);
        log(`  ✓ Created: ${result.alias}`);
        logDebug('alias_created', { alias: result.alias, label });
      } else {
        const reason = classifyHmeError(result.status, result.data);
        log(`  ✗ Failed at ${result.step}: ${reason || 'unclassified'} (status=${result.status}) ${JSON.stringify(result.data).slice(0, 200)}`);
        logDebug('alias_failed', { step: result.step, status: result.status, reason, data: result.data });
        if (reason === 'RATE_LIMITED' || reason === 'QUOTA_EXCEEDED') {
          log(`  Stopping early — Apple reports ${reason.toLowerCase().replace('_', ' ')}.`);
          break;
        }
        if (reason === 'UNAUTHORIZED') {
          log('  Session expired mid-run — stopping.');
          break;
        }
      }
      if (i < CONFIG.count - 1) await sleep(randomDelay(2500, 4500));
    }

    log(`═══════════════════════════════════════════`);
    log(`Done: ${created.length}/${CONFIG.count} alias(es) created.`);
    created.forEach(a => log(`  • ${a}`));
    logDebug('run_complete', { requested: CONFIG.count, created });

    if (created.length > 0) {
      await shot(page, '99-success');
      process.exit(0);
    } else {
      await shot(page, '99-no-aliases');
      process.exit(1);
    }

  } catch (e) {
    logDebug('signup_error', { error: e.message, stack: e.stack });
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
}

main().catch(e => {
  log(`FATAL: ${e.stack || e.message}`);
  process.exit(1);
});
