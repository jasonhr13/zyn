// Riot Games Riftbound account generator
// Flow: GET login → solve hCaptcha → submit email → retrieve OTP → submit OTP → solve hCaptcha → create account

import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchAuthCode } from './imap-client.mjs';
import { argOf, randomAdultDob, sleep, randomDelay, createBotContext, sendAccountCreatedWebhook } from './shared.mjs';
import axios from 'axios';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CONFIG = {
  email: argOf('email', ''),
  password: argOf('password', 'SecurePass123!'),
  // Email auth code (OTP via IMAP)
  imapHost: argOf('imapHost', 'imap.gmail.com'),
  imapPort: parseInt(argOf('imapPort', '993')),
  imapUser: argOf('imapUser', ''),
  imapPass: argOf('imapPass', ''),
  // hCaptcha solver (2Captcha or Anticaptcha)
  hcaptchaApiKey: argOf('hcaptchaApiKey', ''),
  hcaptchaSolver: argOf('hcaptchaSolver', '2captcha'), // '2captcha' or 'anticaptcha'
  // Proxy
  proxyServer: argOf('proxyServer', ''),
  proxyUser: argOf('proxyUser', ''),
  proxyPass: argOf('proxyPass', ''),
  webhook: argOf('webhook', ''),
};

const SIGNUP_ID = argOf('id', 'default');
const DATA_DIR = argOf('data-dir', __dirname);
const { shotsDir, log, logDebug, shot, dumpHtml, logPageState } =
  createBotContext({ dataDir: DATA_DIR, botName: 'riotgames', signupId: SIGNUP_ID });

const RIOT_GAMES_API = 'https://authenticate.riotgames.com/api/v1/login';
const HCAPTCHA_TIMEOUT_MS = 180000; // 180 seconds for hCaptcha solving (Anticaptcha can be slow)
const OTP_TIMEOUT_MS = 60000; // 60 seconds for OTP retrieval

class HCaptchaSolver {
  constructor(apiKey, solver = '2captcha') {
    this.apiKey = apiKey;
    this.solver = solver;
  }

  async solve(siteKey, pageUrl) {
    if (this.solver === '2captcha') {
      return this._solve2Captcha(siteKey, pageUrl);
    } else if (this.solver === 'anticaptcha') {
      return this._solveAnticaptcha(siteKey, pageUrl);
    }
    throw new Error(`Unknown hCaptcha solver: ${this.solver}`);
  }

  async _solve2Captcha(siteKey, pageUrl) {
    try {
      // Submit to 2Captcha
      const submitRes = await axios.post('http://2captcha.com/api/captcha', null, {
        params: {
          key: this.apiKey,
          method: 'hcaptcha',
          sitekey: siteKey,
          pageurl: pageUrl,
          json: 1,
        },
        timeout: 30000,
      });

      const taskId = submitRes.data?.captcha;
      if (!taskId) throw new Error(`Failed to submit hCaptcha: ${JSON.stringify(submitRes.data)}`);

      log(`  hCaptcha task submitted: ${taskId}`);

      // Poll for result
      let solution = null;
      const deadline = Date.now() + HCAPTCHA_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await sleep(3000); // Wait 3s before polling

        const resultRes = await axios.get('http://2captcha.com/api/result', {
          params: {
            key: this.apiKey,
            captcha: taskId,
            json: 1,
          },
          timeout: 30000,
        });

        if (resultRes.data?.status === 1) {
          solution = resultRes.data.request;
          log(`  hCaptcha solved: ${solution.substring(0, 50)}...`);
          return solution;
        }

        if (resultRes.data?.request === 'CAPCHA_NOT_READY') {
          // Still solving, wait and retry
          continue;
        }

        throw new Error(`hCaptcha solve error: ${resultRes.data?.request || 'unknown'}`);
      }

      throw new Error('hCaptcha solver timeout');
    } catch (err) {
      throw new Error(`2Captcha solver failed: ${err.message}`);
    }
  }

  async _solveAnticaptcha(siteKey, pageUrl) {
    try {
      // Create task on Anticaptcha
      const createRes = await axios.post('https://api.anti-captcha.com/createTask', {
        clientKey: this.apiKey,
        task: {
          type: 'HCaptchaTaskProxyless',
          websiteURL: pageUrl,
          websiteKey: siteKey,
          isInvisible: false,
        },
        softId: 0,
        languagePool: 'en',
      });

      const taskId = createRes.data?.taskId;
      if (!taskId) throw new Error(`Failed to create task: ${JSON.stringify(createRes.data)}`);

      log(`  hCaptcha task created: ${taskId}`);

      // Poll for result
      const deadline = Date.now() + HCAPTCHA_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await sleep(3000);

        const resultRes = await axios.post('https://api.anti-captcha.com/getTaskResult', {
          clientKey: this.apiKey,
          taskId: taskId,
        });

        if (resultRes.data?.solution?.gRecaptchaResponse) {
          const solution = resultRes.data.solution.gRecaptchaResponse;
          log(`  hCaptcha solved: ${solution.substring(0, 50)}...`);
          return solution;
        }

        if (!resultRes.data?.isDone) {
          continue;
        }

        throw new Error(`Anticaptcha error: ${resultRes.data?.errorDescription || 'unknown'}`);
      }

      throw new Error('hCaptcha solver timeout');
    } catch (err) {
      throw new Error(`Anticaptcha solver failed: ${err.message}`);
    }
  }
}

async function main() {
  if (!CONFIG.email) {
    log('ERROR: --email required');
    process.exit(1);
  }
  if (!CONFIG.imapUser || !CONFIG.imapPass) {
    log('ERROR: --imapUser and --imapPass required for OTP retrieval');
    process.exit(1);
  }
  if (!CONFIG.hcaptchaApiKey) {
    log('ERROR: --hcaptchaApiKey required for hCaptcha solving');
    process.exit(1);
  }

  log('═══════════════════════════════════════════');
  log('Riot Games (Riftbound) Account Generator');
  log(`Email: ${CONFIG.email}`);
  log(`hCaptcha Solver: ${CONFIG.hcaptchaSolver}`);
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
  log(`HAR capture: ${harFile}`);

  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({ recordHar: { path: harFile, mode: 'full' } });
  const page = await context.newPage();
  const hcaptchaSolver = new HCaptchaSolver(CONFIG.hcaptchaApiKey, CONFIG.hcaptchaSolver);

  try {
    // Step 0: Navigate to Riot Games and click sign in
    log('Step 0: Navigating to Riot Games...');
    await page.goto('https://www.riotgames.com/en', { waitUntil: 'networkidle' });
    await shot(page, '00-main-page');
    await randomDelay(1000, 2000);

    // Step 0b: Find and click sign in button
    log('Step 0b: Clicking sign in button...');
    const signInLink = page.locator('a[data-riotbar-link-id="login"]');
    if (await signInLink.count() === 0) {
      throw new Error('Could not find sign in link');
    }

    // Scroll into view before clicking
    await signInLink.first().scrollIntoViewIfNeeded();
    await randomDelay(500, 1000);

    // Use Promise.all to wait for navigation and click simultaneously
    log('  Clicking and waiting for navigation...');
    try {
      await Promise.all([
        page.waitForURL(/authenticate\.riotgames\.com/, { timeout: 15000 }),
        signInLink.first().click({ force: true, timeout: 10000 })
      ]);
    } catch (err) {
      // If waitForURL fails, try clicking via JavaScript instead
      log('  First attempt failed, trying JavaScript click...');
      await page.evaluate(() => {
        const link = document.querySelector('a[data-riotbar-link-id="login"]');
        if (link) link.click();
      });
      await page.waitForURL(/authenticate\.riotgames\.com/, { timeout: 15000 });
    }

    await page.waitForLoadState('networkidle');
    await randomDelay(2000, 3000);
    await shot(page, '00b-auth-page');
    log(`  Navigated to: ${page.url()}`);

    // Step 1: Dismiss consent banner
    log('Step 1: Dismissing consent banner...');
    await page.waitForLoadState('networkidle');
    await randomDelay(500, 1000);

    try {
      // Try to find and click the reject/dismiss button
      const dismissButtons = [
        page.locator('button:has-text("Reject")'),
        page.locator('button:has-text("Decline")'),
        page.locator('.osano-cm-button--type_denyAll'),
        page.locator('[data-osano-action="CLOSE"]'),
      ];

      for (const btn of dismissButtons) {
        try {
          if (await btn.count() > 0) {
            log('  Clicking dismiss button...');
            await btn.first().click({ force: true, timeout: 3000 });
            await randomDelay(500, 1000);
            break;
          }
        } catch {}
      }
    } catch {}

    await page.waitForLoadState('networkidle');
    await randomDelay(500, 1000);

    // Step 2: Fill email field
    log('Step 2: Filling email...');
    await page.waitForLoadState('networkidle');
    await randomDelay(500, 1000);

    let emailInput = null;
    const emailSelectors = [
      { loc: page.locator('input[type="email"]'), name: 'type=email' },
      { loc: page.locator('input[name*="email" i]'), name: 'name*=email' },
      { loc: page.locator('input[placeholder*="email" i]'), name: 'placeholder*=email' },
      { loc: page.locator('input[type="text"]'), name: 'type=text' },
      { loc: page.locator('input:not([type="checkbox"]):not([type="radio"])'), name: 'not checkbox/radio' },
    ];

    for (const { loc, name } of emailSelectors) {
      try {
        if (await loc.count() > 0) {
          log(`  Found email field: ${name}`);
          emailInput = loc.first();
          break;
        }
      } catch {}
    }

    if (!emailInput) {
      const html = await page.content();
      logDebug('signup_page_html', { html: html.substring(0, 2000) });
      throw new Error('Could not find email input');
    }

    await emailInput.fill(CONFIG.email);
    await randomDelay(500, 1000);
    await shot(page, '01-email-filled');

    // Step 3: Solve hCaptcha
    log('Step 3: Solving hCaptcha...');
    // Get sitekey from iframe src URL
    const hcaptchaIframe = page.locator('iframe[title="hCaptcha challenge"]').first();
    const iframeSrc = await hcaptchaIframe.getAttribute('src');
    if (!iframeSrc) {
      throw new Error('Could not find hCaptcha iframe src');
    }

    // Extract sitekey from URL parameters
    const sitekeyMatch = iframeSrc.match(/sitekey=([^&]+)/);
    const hcaptchaKey = sitekeyMatch ? decodeURIComponent(sitekeyMatch[1]) : null;
    if (!hcaptchaKey) {
      throw new Error(`Could not extract hCaptcha sitekey from: ${iframeSrc.substring(0, 200)}`);
    }
    log(`  hCaptcha sitekey: ${hcaptchaKey}`);
    const hcaptchaToken = await hcaptchaSolver.solve(hcaptchaKey, page.url());

    // Inject the solved token
    await page.evaluate((token) => {
      window.hcaptcha?.getResponse?.();
      const tokenInput = document.querySelector('[name="g-recaptcha-response"], [name="h-captcha-response"]');
      if (tokenInput) tokenInput.value = token;
    }, hcaptchaToken);
    await shot(page, '03-captcha-solved');

    // Step 4: Submit form (email + captcha)
    log('Step 4: Submitting form...');

    let submitBtn = null;
    const submitSelectors = [
      { loc: page.locator('button[type="submit"]'), name: 'submit button' },
      { loc: page.locator('button:has-text("Continue")'), name: 'continue' },
      { loc: page.locator('button:has-text("Next")'), name: 'next' },
      { loc: page.locator('button:has-text("Send")'), name: 'send' },
    ];

    for (const { loc, name } of submitSelectors) {
      try {
        if (await loc.count() > 0) {
          log(`  Found: ${name}`);
          submitBtn = loc.first();
          break;
        }
      } catch {}
    }

    if (!submitBtn) {
      throw new Error('Could not find submit button');
    }

    await submitBtn.click({ timeout: 5000, force: true });
    await randomDelay(2000, 4000);
    await shot(page, '04-form-submitted');

    // Step 5: Retrieve OTP from email
    log('Step 5: Retrieving OTP from email...');
    let otp;
    try {
      const otpResult = await fetchAuthCode(
        {
          user: CONFIG.imapUser,
          password: CONFIG.imapPass,
          host: CONFIG.imapHost,
          port: CONFIG.imapPort,
        },
        CONFIG.email,
        /\b(\d{6})\b/, // 6-digit code
        OTP_TIMEOUT_MS,
        { onLog: log }
      );
      otp = otpResult.code;
      log(`  OTP retrieved: ${otp}`);
      logDebug('otp_retrieved', { otp, matchedTo: otpResult.matchedTo });
    } catch (err) {
      throw new Error(`OTP retrieval failed: ${err.message}`);
    }

    // Step 6: Fill OTP field
    log('Step 6: Filling OTP...');
    await page.waitForLoadState('networkidle');
    await randomDelay(500, 1000);
    let otpInput = await page.locator('input[name*="code" i]').first();
    if (!otpInput.isVisible()) {
      otpInput = await page.locator('input[name*="otp" i]').first();
    }
    if (!otpInput.isVisible()) {
      otpInput = await page.locator('input').filter({ hasAttribute: 'placeholder', hasText: /code|otp/i }).first();
    }
    if (!otpInput.isVisible()) {
      throw new Error('Could not find OTP input');
    }
    await otpInput.fill(otp);
    await randomDelay(500, 1000);
    let otpSubmitBtn = await page.locator('button[type="submit"]').first();
    if (!otpSubmitBtn.isVisible()) {
      otpSubmitBtn = await page.locator('button').filter({ hasText: /verify|continue/i }).first();
    }
    if (!otpSubmitBtn.isVisible()) {
      throw new Error('Could not find OTP submit button');
    }
    await otpSubmitBtn.click();
    await randomDelay(2000, 4000);
    await shot(page, '05-otp-submitted');

    // Step 7: Generate account details
    log('Step 7: Generating account details...');
    const birthDate = randomAdultDob(); // MM/DD/YYYY format from shared.mjs
    const [month, day, year] = birthDate.split('/');
    const username = CONFIG.email.split('@')[0] + Math.random().toString(36).slice(2, 8).toUpperCase(); // e.g. user12ab34
    log(`  Username: ${username}, Birth: ${birthDate}`);

    // Step 7: Fill account creation form
    log('Step 7: Filling account details...');
    await page.waitForLoadState('networkidle');

    // Username
    const usernameInput = await page.locator('input[name="username"], input[placeholder*="username" i]').first();
    if (usernameInput) {
      await usernameInput.fill(username);
      await randomDelay(300, 500);
    }

    // Password
    const passwordInput = await page.locator('input[type="password"], input[name="password"]').first();
    if (passwordInput) {
      await passwordInput.fill(CONFIG.password);
      await randomDelay(300, 500);
    }

    // Birth date (might be separate fields)
    const dayInput = await page.locator('input[name="day"], input[placeholder*="day" i]').first();
    const monthInput = await page.locator('input[name="month"], input[placeholder*="month" i]').first();
    const yearInput = await page.locator('input[name="year"], input[placeholder*="year" i]').first();
    if (dayInput && monthInput && yearInput) {
      await monthInput.fill(month);
      await randomDelay(200, 300);
      await dayInput.fill(day);
      await randomDelay(200, 300);
      await yearInput.fill(year);
      await randomDelay(300, 500);
    }

    await shot(page, '06-account-details-filled');

    // Step 8: Solve second hCaptcha if present
    log('Step 8: Checking for second hCaptcha...');
    try {
      const secondIframe = page.locator('iframe[title="hCaptcha challenge"]').first();
      const secondIframeSrc = await secondIframe.getAttribute('src').catch(() => null);
      if (secondIframeSrc) {
        const secondMatch = secondIframeSrc.match(/sitekey=([^&]+)/);
        const secondSitekey = secondMatch ? decodeURIComponent(secondMatch[1]) : null;
        if (secondSitekey) {
          log('  Solving second hCaptcha...');
          const hcaptchaToken2 = await hcaptchaSolver.solve(secondSitekey, page.url());
          await page.evaluate((token) => {
            window.hcaptcha?.getResponse?.();
            const tokenInput = document.querySelector('[name="g-recaptcha-response"], [name="h-captcha-response"]');
            if (tokenInput) tokenInput.value = token;
          }, hcaptchaToken2);
          await shot(page, '06-second-captcha-solved');
        }
      }
    } catch {}
    await randomDelay(500, 1000);

    // Step 9: Submit account creation form
    log('Step 9: Creating account...');
    let createAcctBtn = await page.locator('button[type="submit"]').first();
    if (!createAcctBtn.isVisible()) {
      createAcctBtn = await page.locator('button').filter({ hasText: /create account/i }).first();
    }
    if (!createAcctBtn.isVisible()) {
      createAcctBtn = await page.locator('button').filter({ hasText: /create/i }).first();
    }
    if (!createAcctBtn.isVisible()) {
      createAcctBtn = await page.locator('button').filter({ hasText: /sign up/i }).first();
    }
    if (!createAcctBtn.isVisible()) {
      throw new Error('Could not find create account button');
    }
    await createAcctBtn.click();
    await randomDelay(3000, 5000);
    await page.waitForLoadState('networkidle');
    await shot(page, '09-account-created');

    log(`✓ Account created successfully!`);
    log(`  Username: ${username}`);
    log(`  Email: ${CONFIG.email}`);

    logDebug('account_created', {
      email: CONFIG.email,
      username: username,
    });

    const puuid = 'unknown'; // We can't get PUUID from web form, would need to login

    // Step 12: Send success webhook
    await sendAccountCreatedWebhook({
      webhookUrl: CONFIG.webhook,
      siteName: 'Riot Games',
      email: CONFIG.email,
      password: CONFIG.password, // Only in user's webhook, not global
    });

    // Success response for IPC
    process.send?.({
      type: 'success',
      data: {
        email: CONFIG.email,
        username: username,
        puuid: puuid,
      },
    });

    process.exit(0);

  } catch (error) {
    log(`✗ Error: ${error.message}`);
    logDebug('error', { message: error.message, stack: error.stack });
    await shot(page, 'error-final');
    await dumpHtml(page, 'error-dom');

    process.send?.({
      type: 'error',
      error: error.message,
    });

    process.exit(1);

  } finally {
    try { await page.close(); } catch {}
    try { await context.close(); } catch {}
    try { await browser.close(); } catch {}
  }
}

main();
