// Shared helpers for all site-registration bots (bandai, icloud, target, walmart) — extracted
// from pbandai-register.mjs so new site modules reuse the same proven, battle-tested
// browser-automation plumbing (human-like typing, diagnostic logging, retry-safe selectors)
// instead of re-deriving it from scratch and re-hitting the same bugs.

import fs from 'node:fs';
import path from 'node:path';


export const argOf = (name, dflt = '') => {
  const a = process.argv.find(x => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : dflt;
};

// For tournament/bulk sign-ups the real identity doesn't matter — every registrant just needs a
// working account. Reused across every site module so a bulk batch doesn't all share one fixed
// identity (a correlatable signal), and so each module doesn't need its own name list.
export const FIRST_NAMES = ['James', 'Mary', 'Robert', 'Patricia', 'John', 'Jennifer', 'Michael', 'Linda', 'David', 'Elizabeth', 'William', 'Barbara', 'Richard', 'Susan', 'Joseph', 'Jessica', 'Thomas', 'Sarah', 'Charles', 'Karen', 'Daniel', 'Nancy', 'Matthew', 'Lisa', 'Anthony', 'Betty', 'Mark', 'Sandra', 'Donald', 'Ashley'];
export const LAST_NAMES = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez', 'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson', 'Thomas', 'Taylor', 'Moore', 'Jackson', 'Martin', 'Lee', 'Perez', 'Thompson', 'White', 'Harris', 'Sanchez', 'Clark', 'Ramirez', 'Lewis', 'Robinson'];
export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// Random DOB guaranteed well over 18 (birth year 1970-2005) — day is clamped to 28 to sidestep
// month-length edge cases (Feb, 30-day months) entirely rather than computing them.
export function randomAdultDob() {
  const year = 1970 + Math.floor(Math.random() * (2005 - 1970 + 1));
  const month = 1 + Math.floor(Math.random() * 12);
  const day = 1 + Math.floor(Math.random() * 28);
  return `${month}/${day}/${year}`;
}

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
export const randomDelay = (min, max) => min + Math.random() * (max - min);

// Account-generation webhooks are deliberately user-configured only. Zyn never sends account
// creation events to a bundled collector, and an empty URL disables this notification entirely.
async function sendWebhook(url, fields, title, color = 0x2dd4bf) {
  if (!url || !/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//.test(url)) return;
  try {
    await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'Zyn',
        avatar_url: 'https://zynbot.app/zyn-icon.png',
        embeds: [{
          title,
          color,
          fields,
          footer: { text: 'Zyn', icon_url: 'https://zynbot.app/zyn-icon.png' },
          timestamp: new Date().toISOString(),
        }],
      }),
      signal: AbortSignal.timeout(5000), // never let a slow/unresponsive webhook host hold anything up
    });
  } catch {}
}

// Fired only to the account-generation webhook configured by this Zyn user. Credentials never go
// anywhere else, and a missing/invalid webhook is a no-op rather than an account-generation error.
export async function sendAccountCreatedWebhook({ webhookUrl, siteName, email, password }) {
  await sendWebhook(webhookUrl, [
    { name: 'Store', value: siteName, inline: true },
    { name: 'Email', value: String(email || '').slice(0, 200), inline: false },
    { name: 'Password', value: String(password || '').slice(0, 200), inline: false },
  ], 'Account created', 0x4ade80);
}

// Creates a bound set of logging/diagnostic/interaction helpers for ONE bot run, writing into
// <dataDir>/<botName>-screenshots/<signupId>/ and <dataDir>/<botName>-<signupId>.log. Call once
// near the top of a script's main(), then destructure whichever helpers it needs.
export function createBotContext({ dataDir, botName, signupId }) {
  const shotsDir = path.join(dataDir, `${botName}-screenshots`, signupId);
  const logFile = path.join(dataDir, `${botName}-${signupId}.log`);
  fs.mkdirSync(shotsDir, { recursive: true });

  function log(msg) {
    const line = `[${new Date().toLocaleString()}] ${msg}`;
    console.log(line);
    try { fs.appendFileSync(logFile, line + '\n'); } catch {}
  }

  function logDebug(type, data) {
    const entry = { ts: new Date().toISOString(), type, ...data };
    const json = JSON.stringify(entry);
    console.log(`[DEBUG] ${json}`);
    try { fs.appendFileSync(logFile, `[DEBUG] ${json}\n`); } catch {}
  }

  async function shot(page, name) {
    const file = path.join(shotsDir, `${name}-${Date.now()}.png`);
    try {
      await page.screenshot({ path: file, fullPage: true });
      log(`📸 Screenshot: ${name}`);
    } catch (e) {
      log(`Screenshot failed (${name}): ${e.message}`);
    }
  }

  // Dumps the live DOM to disk so a wrong-selector guess can be diagnosed offline — a screenshot
  // alone doesn't tell you what the actual input names/ids/placeholders are.
  async function dumpHtml(page, name) {
    const file = path.join(shotsDir, `${name}-${Date.now()}.html`);
    try {
      await fs.promises.writeFile(file, await page.content(), 'utf8');
      log(`📄 HTML dump: ${name} -> ${file}`);
    } catch (e) {
      log(`HTML dump failed (${name}): ${e.message}`);
    }
  }

  async function logPageState(page, label) {
    try {
      log(`  📍 ${label}: ${page.url()} | "${await page.title()}"`);
    } catch (e) {
      log(`  📍 ${label}: could not read page state (${e.message})`);
    }
  }

  // Every form step goes through these three so a wrong selector guess shows up as a clear
  // "✗ NOT FOUND (selector: ...)" line instead of silently no-op'ing and leaving no trace.
  // Waits for `selector` to become visible, up to `timeout`. Returns false if it never does.
  //
  // Playwright's locator.isVisible() IGNORES its timeout option — it is an immediate check. Every
  // one of these helpers used isVisible({ timeout }), so a 30-second timeout waited 13ms and any
  // element that had not rendered yet was reported "NOT FOUND" instantly. On a client-rendered page
  // (Target's signup form is Next.js, mounted after hydration) that meant the generator gave up
  // before the form existed. Measured: isVisible({timeout:5000}) returned false in 13ms where
  // waitFor found the same element in 2350ms.
  async function waitVisible(loc, timeout) {
    return loc.waitFor({ state: 'visible', timeout }).then(() => true).catch(() => false);
  }

  async function tryClick(page, label, selector, { timeout = 5000, settle = 1000 } = {}) {
    const loc = page.locator(selector).first();
    const found = await waitVisible(loc, timeout);
    if (!found) { log(`  ✗ ${label}: NOT FOUND (selector: ${selector})`); return false; }
    log(`  ✓ ${label}: found, clicking`);
    await loc.click();
    await sleep(settle);
    return true;
  }

  // Types character-by-character with randomized per-keystroke delay (real keydown/input/keyup
  // events per character via Playwright's pressSequentially) instead of .fill()'s instant single
  // DOM-value assignment, which fires no real keystroke events at all — a common bot-detection tell.
  async function humanType(page, label, selector, value, { timeout = 3000, minDelay = 70, maxDelay = 220 } = {}) {
    const loc = page.locator(selector).first();
    const found = await waitVisible(loc, timeout);
    if (!found) { log(`  ✗ ${label}: NOT FOUND (selector: ${selector})`); return false; }
    const text = String(value);
    log(`  ✓ ${label}: found, typing ${text.length} character(s)`);
    await loc.click();
    for (const ch of text) {
      await loc.pressSequentially(ch, { delay: 0 });
      await sleep(randomDelay(minDelay, maxDelay));
    }
    return true;
  }

  async function trySelect(page, label, selector, value, { timeout = 3000, settle = 300 } = {}) {
    const loc = page.locator(selector).first();
    const found = await waitVisible(loc, timeout);
    if (!found) { log(`  ✗ ${label}: NOT FOUND (selector: ${selector})`); return false; }
    log(`  ✓ ${label}: found, selecting "${value}"`);
    // Try matching by option VALUE first (e.g. "US"), then fall back to visible LABEL text (e.g.
    // "Texas") — we often don't know which form a given <select>'s real option values take.
    try {
      await loc.selectOption(value);
    } catch {
      try {
        await loc.selectOption({ label: value });
      } catch (e) {
        log(`  ⚠ ${label}: found but no option matches value or label "${value}" (${e.message})`);
        return false;
      }
    }
    await sleep(settle);
    return true;
  }

  return { shotsDir, logFile, log, logDebug, shot, dumpHtml, logPageState, tryClick, humanType, trySelect };
}
