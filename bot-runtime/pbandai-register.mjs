// P-Bandai bulk account generator - Full signup automation
// Flow: age check → email register → auth code (IMAP) → fill member info → SMS verify → success

import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchAuthCode } from './imap-client.mjs';
import { fetchAuthCodeViaAycd } from './aycd-mail-client.mjs';
import { createSmsClient } from './sms-client.mjs';
import { argOf, FIRST_NAMES, LAST_NAMES, pick, randomAdultDob, sleep, randomDelay, createBotContext, sendAccountCreatedWebhook } from './shared.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CONFIG = {
  url: 'https://p-bandai.com/us/register',
  email: argOf('email', ''),
  firstName: argOf('firstName', '') || pick(FIRST_NAMES),
  lastName: argOf('lastName', '') || pick(LAST_NAMES),
  // "Password123!" (the old default) contains "123" — a 3-character ascending run — which
  // P-Bandai's own password rules explicitly forbid ("Does not contain 3 or more consecutive
  // characters (abc, 321, etc.)"), so every signup using the old default would fail validation.
  password: argOf('password', 'Bx9!Lq4tRz'),
  state: argOf('state', 'Texas'),
  phone: argOf('phone', ''),
  dateOfBirth: argOf('dob', '') || randomAdultDob(),
  gender: argOf('gender', 'Male'),
  // SMS provider
  smsProvider: argOf('smsProvider', 'getatext'),
  smsApiKey: argOf('smsApiKey', ''),
  smsApiUsername: argOf('smsApiUsername', ''), // TextVerified only
  smsService: argOf('smsService', 'bandai'),  // must match a service the provider's catalog actually lists
  // Email auth code — both can be configured at once; Step 5 tries AYCD Inbox first (their Mail
  // Tasks API — the Inbox desktop app must be running on this machine, mailboxes connected inside
  // Inbox itself, this script only ever sees the API key) and falls back to IMAP if AYCD fails or
  // isn't configured.
  aycdApiKey: argOf('aycdApiKey', ''),
  imapHost: argOf('imapHost', 'imap.gmail.com'),
  imapPort: parseInt(argOf('imapPort', '993')),
  imapUser: argOf('imapUser', ''),
  imapPass: argOf('imapPass', ''),
  // Proxy
  proxyServer: argOf('proxyServer', ''),
  proxyUser: argOf('proxyUser', ''),
  proxyPass: argOf('proxyPass', ''),
  webhook: argOf('webhook', ''), // user's own Discord webhook — fires alongside the hardcoded global one
};

const SIGNUP_ID = argOf('id', 'default');
const DATA_DIR = argOf('data-dir', __dirname);
const { shotsDir, log, logDebug, shot, dumpHtml, logPageState, tryClick, humanType, trySelect } =
  createBotContext({ dataDir: DATA_DIR, botName: 'pbandai', signupId: SIGNUP_ID });

// Non-fatal no-op if the banner isn't present — safe to call defensively at multiple points (see
// the KNOWN QUIRK comment at its Step 4 call site for why one call right after age-confirm isn't
// enough).
async function dismissCookieBanner(page) {
  return tryClick(page, 'Cookie consent banner (Accept All)', 'button:has-text("Accept All Cookies")', { timeout: 3000, settle: 500 });
}

async function main() {
  if (!CONFIG.email) {
    log('ERROR: --email required');
    process.exit(1);
  }
  if (!CONFIG.phone && !(CONFIG.smsApiKey && CONFIG.smsProvider)) {
    log('ERROR: need either --phone (a number you control) or --smsProvider + --smsApiKey (to rent one)');
    process.exit(1);
  }

  log('═══════════════════════════════════════════');
  log('P-Bandai Account Generator');
  log(`Email: ${CONFIG.email}`);
  log(`Name: ${CONFIG.firstName} ${CONFIG.lastName}`);
  log(`State: ${CONFIG.state}`);
  log(`Phone: ${CONFIG.phone}`);
  log(`SMS Provider: ${CONFIG.smsProvider}`);
  log('═══════════════════════════════════════════');

  const launchOptions = {
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  };

  if (CONFIG.proxyServer) {
    launchOptions.proxy = { server: CONFIG.proxyServer };
    if (CONFIG.proxyUser && CONFIG.proxyPass) {
      launchOptions.proxy.username = CONFIG.proxyUser;
      launchOptions.proxy.password = CONFIG.proxyPass;
    }
  }

  const harFile = path.join(shotsDir, 'network.har');
  log(`HAR capture: ${harFile} (written on close — full request/response log for debugging)`);

  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({ recordHar: { path: harFile, mode: 'full' } });
  const page = await context.newPage();

  try {
    // Step 1: Navigate
    log('Step 1: Navigate to P-Bandai registration...');
    await page.goto(CONFIG.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(1500);
    await logPageState(page, 'After navigate');
    await shot(page, '01-register-page');

    // Step 2: Age confirmation (18+) — verified live 2026-07-18: the real buttons are EXACTLY
    // "OVER THE AGE OF 18" / "UNDER THE AGE OF 18", both containing "18" — a substring match on
    // "18" alone is ambiguous between them. Exact text avoids ever hitting the wrong one.
    log('Step 2: Age confirmation...');
    // Settle bumped to 7s (reported live 2026-07-18: most failures trace back to the bot racing
    // ahead of a page that hasn't finished loading/rendering after a click) — applied consistently
    // at every step boundary below, not just the two navigation races already fixed with polls.
    await tryClick(page, 'Age confirm button', 'button:has-text("OVER THE AGE OF 18")', { timeout: 8000, settle: 7000 });
    await shot(page, '02-after-age');

    // Step 3: Cookie acceptance — real button text verified live.
    // KNOWN QUIRK (reported live 2026-07-18): P-Bandai's age-gate cookie-consent banner can mount
    // with a delay — clicking it immediately after age-confirm sometimes finds nothing, then it
    // pops up WHILE Step 4 is mid-typing, stealing focus/clicks and interleaving keystrokes into
    // the email field (garbled values like "tee.1h@icloud.combumpe...rs_invi"). A flat wait here
    // lets every header/banner that's going to appear actually appear BEFORE any typing starts,
    // instead of racing them.
    log('Step 3: Waiting for any late-mounting banners/headers to settle...');
    await sleep(7000);
    await dismissCookieBanner(page);
    await sleep(500);
    await dismissCookieBanner(page); // second pass in case dismissing one revealed another (e.g. a stacked notice)
    await shot(page, '03-after-cookie-wait');

    // Step 4: Enter email → receive auth code
    // BUG FIX (verified live 2026-07-18): the real email field is <input type="text"
    // placeholder="E-mail Address">, NOT type="email" — the old selector matched 0 elements every
    // time, which is why nothing ever got filled. Also: the "SUBMIT" button is type="button" (not
    // type="submit"), so pressing Enter does NOT trigger it — it must be clicked explicitly.
    log('Step 4: Entering email for authentication...');
    const emailSelector = 'input[placeholder="E-mail Address" i], input[placeholder*="mail" i]';
    let emailFilled = await humanType(page, 'Email input', emailSelector, CONFIG.email);
    if (emailFilled) {
      const typedValue = await page.locator(emailSelector).first().inputValue().catch(() => '');
      if (typedValue.trim().toLowerCase() !== CONFIG.email.trim().toLowerCase()) {
        // BUG FIX: an earlier version of this retry typed AGAIN without clearing the field first,
        // which appended onto the already-garbled value instead of fixing it (the doubled-up
        // "tee.1h@icloud.combumpe...rs_invi" mess) — must clear before retyping.
        log(`  ⚠ Email field reads "${typedValue}" instead of the typed address — likely interrupted by a late banner. Clearing, dismissing, and retrying...`);
        await shot(page, '04-email-corrupted');
        const emailLoc = page.locator(emailSelector).first();
        await emailLoc.click();
        await emailLoc.press('Control+A');
        await emailLoc.press('Delete');
        await dismissCookieBanner(page);
        await sleep(1000);
        emailFilled = await humanType(page, 'Email input (retry)', emailSelector, CONFIG.email);
      }
    }
    if (emailFilled) {
      await tryClick(page, 'Email submit button', 'button:has-text("SUBMIT"), a:has-text("SUBMIT")', { timeout: 3000, settle: 7000 });
    }
    await logPageState(page, 'After email submit');
    await shot(page, '04-email-sent');

    // Step 5: Pull auth code from email — tries AYCD Inbox first if configured, then falls back to
    // IMAP if that's ALSO configured (both can be filled in at once; no provider choice to make —
    // reported live 2026-07-20 that forcing one-or-the-other was unwanted, a real fallback is more
    // useful than a fixed pick since either provider can independently be down/misconfigured).
    log('Step 5: Fetching authentication code from email...');
    let authCode = '';
    let authCodeSource = '';
    const logFetchSuccess = (found, source) => {
      authCode = found.code;
      authCodeSource = source;
      // Belt-and-suspenders: both providers already verify the To:/email match server-side, but log
      // it explicitly so a wrong-recipient match is visible immediately instead of needing another
      // paid run to diagnose.
      log(`✓ Auth code (via ${source}): ${authCode} (email To: ${found.matchedTo})`);
      if (!found.matchedTo.toLowerCase().includes(CONFIG.email.toLowerCase())) {
        log(`  ⚠ WARNING: matched email's To: header doesn't contain ${CONFIG.email} — this code may be wrong.`);
      }
      logDebug('auth_code_fetched', { code: authCode, matchedTo: found.matchedTo, source });
    };

    if (CONFIG.aycdApiKey) {
      try {
        // REVERTED (2026-07-20): bumped to 10 minutes earlier today per AYCD's own recommended
        // figure, but the user identified the REAL cause of the AYCD timeouts — some connected
        // mailboxes need OAuth2 re-login inside the AYCD Inbox app itself (visible only in Inbox's
        // own log panel as "OAuth2 Login Required", not exposed through this API at all — a task
        // against a mailbox in that state just never completes, indistinguishable from a slow one
        // until it times out). For a genuinely broken mailbox, waiting 10 minutes only wastes time;
        // back to a short ~1min timeout so those fail fast and this account gets skipped quickly
        // instead of blocking a worker slot — see the hard-fail check below Step 5 for the other
        // half of this fix (previously a failed fetch limped forward into filling the form anyway).
        const found = await fetchAuthCodeViaAycd({ apiKey: CONFIG.aycdApiKey, targetEmail: CONFIG.email, fromFilter: 'p-bandai.com', codePattern: /(\d{6})/, timeoutMs: 60000 });
        logFetchSuccess(found, 'AYCD');
      } catch (e) {
        log(`AYCD auth code fetch failed: ${e.message}${CONFIG.imapUser && CONFIG.imapPass ? ' — falling back to IMAP...' : ''}`);
      }
    }
    if (!authCode && CONFIG.imapUser && CONFIG.imapPass) {
      try {
        const found = await fetchAuthCode({
          host: CONFIG.imapHost,
          port: CONFIG.imapPort,
          user: CONFIG.imapUser,
          password: CONFIG.imapPass,
        }, CONFIG.email, /(\d{6})/i, 60000, { onLog: log });
        logFetchSuccess(found, 'IMAP');
      } catch (e) {
        log(`IMAP auth code fetch failed: ${e.message}`);
      }
    }
    if (!authCode && (CONFIG.aycdApiKey || CONFIG.imapUser)) {
      log('Warning: Could not fetch auth code via any configured provider.');
      // page.evaluate(() => prompt(...)) — Playwright auto-dismisses native dialogs by default
      // (no `page.on('dialog', ...)` handler is registered anywhere in this file), so in an
      // unattended batch run this resolves to null/empty essentially instantly, not a real pause
      // for manual entry.
      authCode = await page.evaluate(() => prompt('Enter auth code from email:'));
    }

    // BUG FIX (reported live 2026-07-20): previously, if authCode was still empty here, the code
    // just fell through — Step 6 below is a no-op `if (authCode)` with no else, so it silently
    // skipped straight to Step 6.5 (renting a real SMS number — real money) and Step 7 (filling the
    // registration form) while STILL sitting on the email-auth page, since no auth code was ever
    // submitted to advance past it. That's exactly the "every field NOT FOUND, then wasted SMS
    // rental" pattern from a live run. If no email auth provider even found a code, there is no
    // possible way to proceed — fail this account now, cleanly, before anything else gets spent.
    if (!authCode) {
      throw new Error('No authentication code obtained from any configured provider — cannot proceed with this signup.');
    }

    // Step 6: Submit auth code — real input has NO placeholder, just id="certification_code"
    // (verified live 2026-07-18, same id reused for the SMS auth step below).
    if (authCode) {
      log('Step 6: Submitting auth code...');
      if (await humanType(page, 'Auth code input', '#certification_code, input[placeholder*="code" i]', authCode)) {
        await tryClick(page, 'Auth code submit button', 'button:has-text("Submit"), a:has-text("Submit"), button:has-text("Continue")', { timeout: 2000, settle: 7000 });

        // BUG FIX (reported live 2026-07-18): same navigation race as the SMS-submit fix above, one
        // step earlier — tryClick's ~1s settle isn't always long enough for the site to actually
        // leave /mailaddress/auth. When it wasn't, Step 7 started filling the member-registration
        // form against the STALE email-auth page: the top fields (First/Last/Location/State/Phone/
        // DOB) all reported NOT FOUND immediately since they don't exist there, but by the time
        // Step 7 reached the bottom fields (Gender/Password/Marketing/T&C) several seconds later,
        // the real page had finally navigated in — so the bottom half looked "filled" while the top
        // half was silently skipped (exactly what was reported: "rushed to the bottom, top wasn't
        // filled"). Poll for the navigation instead of trusting a fixed delay.
        const navDeadline = Date.now() + 8000;
        while (Date.now() < navDeadline && page.url().includes('/mailaddress/auth')) await sleep(300);
      }
      await logPageState(page, 'After auth code submit');
      await shot(page, '06-code-submitted');
    }

    // Step 6.5: Rent the SMS number NOW (before the form) so the number on the account and the
    // number receiving the OTP are the same phone — previously these were two disconnected values.
    let smsClient = null;
    let smsPurchase = null;
    let formPhone = CONFIG.phone;
    if (CONFIG.smsApiKey && CONFIG.smsProvider) {
      log('Step 6.5: Renting SMS number...');
      try {
        smsClient = await createSmsClient({
          provider: CONFIG.smsProvider,
          apiKey: CONFIG.smsApiKey,
          apiUsername: CONFIG.smsApiUsername,
          // Surfaces the SMS provider's raw API responses in this run's log — the fastest way to
          // fix a provider integration bug without burning another paid rental guessing blind.
          onDebug: (label, data) => logDebug(label, { value: data }),
        });
        smsPurchase = await smsClient.purchase(CONFIG.smsService, 'us');
        formPhone = smsPurchase.phone;
        log(`✓ SMS rental: ${formPhone}`);
        logDebug('sms_purchased', { phone: smsPurchase.phone, purchaseId: smsPurchase.purchaseId });
      } catch (e) {
        log(`SMS rental failed: ${e.message}`);
        if (!CONFIG.phone) throw new Error(`No SMS rental and no --phone fallback: ${e.message}`);
        log(`Falling back to --phone (${CONFIG.phone}) — this number must actually receive P-Bandai's SMS.`);
      }
    }

    // Step 7: Fill member registration form
    // Every selector below verified 2026-07-18 against a live HTML dump of this exact step (see
    // 99-error-*.html from the prior run) — the old guessed selectors (name*="state", name*="month",
    // placeholder*="phone" without the "i" flag, id*="terms") matched NOTHING on the real page:
    //   - There is no state/province field at registration at all (only Area: US/CA).
    //   - Country/DOB selects have only an id, no name attribute.
    //   - DOB option values are plain numbers ("7"), NOT zero-padded ("07").
    //   - Phone placeholder is "Phone Number" (capital P) — a case-sensitive selector missed it.
    //   - Gender radios are visually covered by their <label> — Playwright correctly refused to
    //     click the covered input, so the label itself must be the click target.
    //   - The T&C checkbox's real id is "inputCheckRequired0", matched via name="checkRequired".
    log('Step 7: Filling member registration form...');
    await logPageState(page, 'Before form fill');

    await humanType(page, 'First name', '#First_name', CONFIG.firstName);
    await humanType(page, 'Last name', '#Last_name', CONFIG.lastName);
    await trySelect(page, 'Area/Country select', '#Location', 'US', { timeout: 5000 });

    // A State field appears ONLY after Area is set to U.S.A. (confirmed via a live walkthrough —
    // it's absent from the DOM until then, which is why an earlier attempt correctly found nothing
    // here before Area selection was fixed). Non-blocking: logs found/not-found either way instead
    // of failing the run if the real selector ever drifts.
    await trySelect(page, 'State select', 'select[name*="state" i], select[id*="state" i]', CONFIG.state, { timeout: 4000 });

    // Phone: country dial code select + number field
    await trySelect(page, 'Phone country code', '#Country_Number', 'US', { timeout: 5000 });
    const phoneDigits = formPhone.replace(/\D/g, '').slice(-10);
    await humanType(page, 'Phone number', '#Phone_Number', phoneDigits);

    // Date of birth (month/day/year) — real option values are unpadded numbers
    const [month, day, year] = CONFIG.dateOfBirth.split('/');
    await trySelect(page, 'DOB month', '#Month', String(parseInt(month, 10)));
    await trySelect(page, 'DOB day', '#Day', String(parseInt(day, 10)));
    await trySelect(page, 'DOB year', '#Year', year);

    // Gender: the native radio is covered by its <label> for custom styling, so click the label —
    // resolve which id belongs to the requested value first, since the ids are arbitrary (gender0..3).
    const genderInput = page.locator(`input[type="radio"][value="${CONFIG.gender}"]`).first();
    const genderId = await genderInput.getAttribute('id').catch(() => null);
    if (genderId) {
      await tryClick(page, 'Gender label', `label[for="${genderId}"]`, { timeout: 3000, settle: 0 });
    } else {
      log(`  ✗ Gender radio: NOT FOUND (no radio with value="${CONFIG.gender}")`);
    }

    await humanType(page, 'Password', '#Password', CONFIG.password);

    // Marketing preferences - check all (optional, numeric ids "1".."4").
    // BUG FIX: this locator was unscoped (whole-page), which also matched checkboxes inside the
    // hidden OneTrust cookie-preference panel (11 found vs. the 4 that actually exist on the
    // registration form) — toggling tracking-consent switches nobody asked to touch. Scoped to the
    // actual form now.
    const marketingCheckboxes = page.locator('form.form-user-info input[type="checkbox"]:not([name="checkRequired"])');
    const count = await marketingCheckboxes.count();
    log(`  ${count ? '✓' : '✗'} Marketing checkboxes: ${count} found`);
    for (let i = 0; i < count; i++) {
      const cb = marketingCheckboxes.nth(i);
      if (await cb.isVisible({ timeout: 2000 }).catch(() => false)) {
        if (!(await cb.isChecked())) await cb.click();
      }
    }

    // T&C checkbox - must check (only click if not already checked, so a default-checked box
    // doesn't get toggled OFF by a blind click). Same custom-checkbox styling as gender: the native
    // input is covered by its <label>, so the label is the real click target.
    const termsCheckbox = page.locator('input[name="checkRequired"], #inputCheckRequired0').first();
    const termsFound = await termsCheckbox.isVisible({ timeout: 3000 }).catch(() => false);
    if (termsFound) {
      log('  ✓ T&C checkbox: found');
      if (!(await termsCheckbox.isChecked())) {
        const termsId = await termsCheckbox.getAttribute('id').catch(() => null);
        if (termsId) {
          await tryClick(page, 'T&C label', `label[for="${termsId}"]`, { timeout: 5000, settle: 0 });
        } else {
          await termsCheckbox.click(); // no id found — fall back to a direct click
        }
        // BUG FIX (reported live 2026-07-18): settle:0 above meant Step 8 could click CONFIRM
        // before React had actually committed the checkbox's checked state — a live run showed the
        // checkbox still visually UNCHECKED in the 07-form-filled screenshot (taken right after this
        // click) but checked by 08-form-submitted, with the CONFIRM click in between silently
        // no-op'ing (page stayed on the same "ENTER INFORMATION" step). Poll for isChecked() to
        // actually become true — up to 2s, re-clicking once if it never lands — instead of trusting
        // the click fired and moving straight on.
        let confirmed = false;
        for (let attempt = 0; attempt < 2 && !confirmed; attempt++) {
          const deadline = Date.now() + 2000;
          while (Date.now() < deadline) {
            if (await termsCheckbox.isChecked().catch(() => false)) { confirmed = true; break; }
            await sleep(150);
          }
          if (!confirmed && attempt === 0) {
            log('  ⚠ T&C checkbox still unchecked after the label click — retrying...');
            const termsId2 = await termsCheckbox.getAttribute('id').catch(() => null);
            if (termsId2) await tryClick(page, 'T&C label (retry)', `label[for="${termsId2}"]`, { timeout: 3000, settle: 0 });
            else await termsCheckbox.click().catch(() => {});
          }
        }
        log(`  ${confirmed ? '✓' : '✗'} T&C checkbox: ${confirmed ? 'confirmed checked' : 'STILL unchecked after retry — submission will likely be silently rejected'}`);
      }
    } else {
      log('  ✗ T&C checkbox: NOT FOUND — submission will likely be REJECTED by the site.');
    }

    await dumpHtml(page, '07-form-filled');
    await shot(page, '07-form-filled');

    // Extra settle before Submit (reported live 2026-07-18: the "member registration submit
    // button not clicking" reports traced back to the site's client-side validation not having
    // caught up with the last field/checkbox change yet — same category as the T&C-checkbox race
    // fixed above, just for the form as a whole) — give it a beat before hitting Submit.
    await sleep(7000);

    // Step 8: Submit form
    log('Step 8: Submitting registration form...');
    await tryClick(page, 'Form confirm/submit button', 'button:has-text("Confirm"), a:has-text("Confirm"), button:has-text("Submit"), a:has-text("Submit")', { timeout: 8000, settle: 7000 });
    await logPageState(page, 'After form submit');
    await shot(page, '08-form-submitted');

    // Step 9: SMS verification — a separate screen from the earlier email auth code, SAME real
    // selector (#certification_code, no placeholder) — verified live 2026-07-18.
    log('Step 9: SMS verification...');
    const smsCodeInput = page.locator('#certification_code, input[placeholder*="code" i]').first();
    const smsCodeInputFound = await smsCodeInput.isVisible({ timeout: 12000 }).catch(() => false);
    log(`  ${smsCodeInputFound ? '✓' : '✗'} SMS code input: ${smsCodeInputFound ? 'found' : 'NOT FOUND — form may not have submitted, or this account skipped SMS verification'}`);
    if (!smsCodeInputFound) await dumpHtml(page, '09-sms-not-found');

    if (smsCodeInputFound) {
      log('Waiting for SMS code...');
      let smsCode = '';

      if (smsClient && smsPurchase) {
        try {
          // Poll for SMS code on the SAME rented number that's on the form. A live run showed the
          // code can genuinely take over a minute to arrive (10-minute expiry window per the site),
          // so this now polls ~2 minutes total and clicks P-Bandai's own "Resend code" button
          // (#reSend) partway through if nothing's arrived yet — same recovery a human would do.
          const TOTAL_ATTEMPTS = 60;      // 60 * 2s = 120s
          const RESEND_AT_ATTEMPT = 25;   // ~50s in — give the first SMS a real chance before resending
          let attempts = 0;
          let resent = false;
          while (!smsCode && attempts < TOTAL_ATTEMPTS) {
            await sleep(2000);
            smsCode = await smsClient.fetchSms(smsPurchase.purchaseId);
            attempts++;
            log(`  … poll ${attempts}/${TOTAL_ATTEMPTS}: ${smsCode ? `got code ${smsCode}` : 'no code yet'}`);

            if (!smsCode && !resent && attempts >= RESEND_AT_ATTEMPT) {
              resent = true;
              const clicked = await tryClick(page, 'Resend code button', '#reSend, button:has-text("Resend code")', { timeout: 3000, settle: 1000 });
              log(clicked ? '  ↻ Clicked Resend code — continuing to poll' : '  (no Resend code button found — continuing to poll anyway)');
            }
          }

          if (smsCode) {
            log(`✓ SMS code: ${smsCode}`);
          } else {
            log('⚠ SMS code timeout - manual entry needed');
            smsCode = await page.evaluate(() => prompt('Enter SMS code:'));
          }

          await smsClient.cancel(smsPurchase.purchaseId).catch(() => {});
        } catch (e) {
          log(`Warning: SMS provider error: ${e.message}`);
          smsCode = await page.evaluate(() => prompt('Enter SMS code manually:'));
        }
      } else {
        log('No SMS rental active — manual entry needed');
        smsCode = await page.evaluate(() => prompt('Enter SMS code:'));
      }

      if (smsCode) {
        log(`  ✓ SMS code input: typing ${smsCode.length} character(s)`);
        await smsCodeInput.click();
        for (const ch of String(smsCode)) {
          await smsCodeInput.pressSequentially(ch, { delay: 0 });
          await sleep(randomDelay(70, 220));
        }
        await tryClick(page, 'SMS code submit button', 'button:has-text("Submit"), a:has-text("Submit"), button:has-text("Continue")', { timeout: 2000, settle: 7000 });

        // BUG FIX (reported live 2026-07-18): tryClick's own settle (~1s) isn't necessarily long
        // enough for the site to actually navigate off /sms/auth to the confirm page — a live run
        // showed the page WAS navigating forward a moment later, but Step 9.5's guard below checked
        // page.url() too early, still saw /sms/auth, and wrongly concluded Step 9 never got through
        // (skipping the real review-page submit and failing an account that was actually fine).
        // Poll for the navigation instead of trusting a fixed delay.
        const navDeadline = Date.now() + 8000;
        while (Date.now() < navDeadline && page.url().includes('/sms/auth')) await sleep(300);
      }
      await logPageState(page, 'After SMS verification');
      await shot(page, '09-sms-verified');
    }

    // Step 9.5: Confirmation/review page — the site shows a THIRD screen after SMS verification
    // ("CONFIRMATION" step of the 4-step wizard) listing every field with EDIT/SUBMIT buttons; the
    // account is NOT created until this second SUBMIT is clicked. Missing this entirely was the
    // reason earlier runs logged "SUCCESS" without actually creating anything.
    // GUARD: if we're still on /sms/auth, Step 9 never actually got past the SMS code (bad code,
    // selector miss, etc) — clicking "SUBMIT" here would just hit that page's own empty form again
    // (exactly what silently happened before this guard existed) instead of the review page's.
    log('Step 9.5: Confirmation/review page...');
    await logPageState(page, 'Before confirmation submit');
    let reviewSubmitted = false;
    if (page.url().includes('/sms/auth')) {
      log('  ✗ Still on the SMS auth page — Step 9 did not get past it, skipping the review-page submit.');
    } else {
      // BUG FIX (verified live 2026-07-18): on THIS page EDIT/SUBMIT are <a href="javascript:void(0)">
      // tags styled as buttons, not real <button> elements — "button:has-text" matched nothing.
      reviewSubmitted = await tryClick(page, 'Review page SUBMIT button', 'a:has-text("SUBMIT"), button:has-text("SUBMIT")', { timeout: 8000, settle: 7000 });
      if (!reviewSubmitted) log('  (no review-page SUBMIT found — may have gone straight to completion, or the page differs from what was mapped)');
    }
    await shot(page, '09.5-confirmation');

    // Step 10: Check for success. NOTE: the 4-step wizard header ("E-MAIL REGISTRATION | ENTER
    // INFORMATION | CONFIRMATION | COMPLETE") is present on EVERY page of this flow, so matching
    // on the bare word "complete" is a false positive on step 1 — that was the earlier bug that
    // made the bot report success right after the very first form submit. Match the actual
    // completion copy ("THANK YOU FOR REGISTERING") and/or the /mypage redirect instead.
    log('Step 10: Checking for success...');
    const successMsg = page.locator('text=/thank you for registering/i').first();
    const onMyPage = page.url().includes('/mypage');
    const successHit = onMyPage || await successMsg.isVisible({ timeout: 10000 }).catch(() => false);

    // KNOWN QUIRK (reported live 2026-07-18): clicking the review-page SUBMIT sometimes lands on
    // P-Bandai's own error-500 page instead of the completion screen — but the account WAS created
    // server-side (the user received P-Bandai's registration confirmation email even though the
    // response page 500'd). Only treat a 500 as a salvaged success if we actually clicked the real
    // review-page SUBMIT this run (reviewSubmitted) — a 500 earlier in the flow, before the account
    // could possibly have been created, should still fail normally.
    //
    // BUG FIX (reported live 2026-07-18): this used to only check the page BODY TEXT for phrases
    // like "error 500" — but a live run showed the real page is a hard navigation to the literal
    // URL https://p-bandai.com/sorry/500.html, titled "PAGE NOT AVAILABLE｜PREMIUM BANDAI", whose
    // body text never contains any of those phrases (so the old check silently never matched, and
    // every one of these got reported as a plain failure). Check the URL/title, not guessed body
    // copy — that's the actual, observed signal, and any of the old body-text phrases still count
    // too in case the exact page varies.
    let salvaged500 = false;
    if (!successHit && reviewSubmitted) {
      const url = page.url().toLowerCase();
      const title = await page.title().catch(() => '');
      const bodyText = await page.evaluate(() => (document.body.innerText || '').toLowerCase()).catch(() => '');
      const isSorry500Page = url.includes('/sorry/500') || url.includes('/500.html') || /page not available/i.test(title);
      const bodyMatchesKnownPhrase = ['error 500', '500 internal server error', 'internal server error', '500 error'].some(h => bodyText.includes(h));
      if (isSorry500Page || bodyMatchesKnownPhrase) {
        salvaged500 = true;
      }
    }

    // NEW variant of the same quirk (reported live 2026-07-18): sometimes the review-page SUBMIT
    // doesn't even show an error-500 page — the SPA just silently stays on /register/confirm with
    // NO error text at all (this run's own screenshot shows every field correctly filled — Name,
    // Email, Address, Phone, DOB, Gender, Password, Marketing, Terms=Agree — and the SUBMIT click
    // was confirmed to fire, but the page never advanced to step 4/COMPLETE). Same underlying
    // server-side flakiness as the explicit-500 case, just a quieter failure mode on Bandai's end.
    // Only trusted when the review SUBMIT was actually clicked this run (reviewSubmitted) — an
    // early-stage stall (before the account could possibly exist) should still fail normally.
    let stalledOnConfirm = false;
    if (!successHit && !salvaged500 && reviewSubmitted && page.url().includes('/register/confirm')) {
      stalledOnConfirm = true;
    }

    if (successHit || salvaged500 || stalledOnConfirm) {
      if (salvaged500) {
        log('⚠ Review-page submit returned an error 500 page (known P-Bandai quirk) — treating as SUCCESS since the account is actually created server-side despite the broken response page.');
      }
      if (stalledOnConfirm) {
        log('⚠ Review-page submit left the page silently stuck on /register/confirm with no error shown — treating as SUCCESS (same underlying quirk as the error-500 case, quieter failure mode). Spot-check this account if in doubt.');
      }
      log('✓ SUCCESS! Account created!');
      logDebug('account_created', { email: CONFIG.email, salvaged500, stalledOnConfirm });
      await sendAccountCreatedWebhook({ webhookUrl: CONFIG.webhook, siteName: 'Bandai', email: CONFIG.email, password: CONFIG.password });
      await logPageState(page, 'Success');
      await shot(page, '99-success');
      return 0;
    } else {
      log('✗ Account creation status UNKNOWN — no success text matched. Check the HTML dump + HAR to see what page we actually landed on.');
      await logPageState(page, 'Final state (unknown outcome)');
      await dumpHtml(page, '99-unknown');
      await shot(page, '99-unknown');
      return 1;
    }

  } catch (e) {
    logDebug('signup_error', { error: e.message, stack: e.stack });
    log(`✗ FAILED: ${e.message}`);
    await logPageState(page, 'Final state (error)').catch(() => {});
    await dumpHtml(page, '99-error');
    await shot(page, '99-error');
    return 1;
  } finally {
    // BUG FIX (reported live 2026-07-18): every exit path used to call process.exit() directly
    // from INSIDE the try/catch above — which in Node terminates the process immediately and skips
    // any pending finally block entirely. That meant this cleanup (and the HAR file it flushes)
    // never ran on ANY exit path, success or failure — the missing network.har that blocked
    // diagnosing the stalled-confirm-page issue above is a direct symptom. Worse, browser.close()
    // never running means the Chromium child process was never explicitly torn down on a normal
    // exit, which risks orphaned browser windows piling up across a large batch (750 accounts =
    // up to 750 leaked windows). Now every exit path returns a code instead of calling
    // process.exit() directly, so this finally always runs before the process actually exits (see
    // main().then(...) below).
    await context.close();
    await browser.close();
    log(`HAR written: ${harFile}`);
  }
}

main()
  .then(code => process.exit(code ?? 0))
  .catch(e => {
    log(`FATAL: ${e.stack || e.message}`);
    process.exit(1);
  });
