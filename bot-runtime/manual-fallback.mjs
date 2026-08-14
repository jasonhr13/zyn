// manual-fallback.mjs — opens a headed browser for manual checkout completion
// Args: <cookiePath> <url> <threadId>
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, appendFileSync, unlinkSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir    = dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = join(__dir, '..', 'logs');

const [,, cookiePath, targetUrl, threadId = '?', proxyJson = ''] = process.argv;
const LOCK_FILE = join(LOGS_DIR, `manual-${Date.now()}-t${threadId}.lock`);
const ERR_LOG   = join(LOGS_DIR, `manual-t${threadId}-err.log`);
const MAX_OPEN  = 10;

let _proxy = null;
try { if (proxyJson) _proxy = JSON.parse(proxyJson); } catch {}

function mlog(msg) {
  try { appendFileSync(ERR_LOG, `[${new Date().toISOString()}] ${msg}\n`); } catch {}
}

mlog(`started — cookiePath=${cookiePath} url=${targetUrl} proxy=${_proxy?.server || 'none'}`);

// ── Wait for a free slot (max MAX_OPEN manual browsers at once) ───────────────
while (true) {
  const active = readdirSync(LOGS_DIR).filter(f => /^manual-\d+-t.+\.lock$/.test(f)).length;
  if (active < MAX_OPEN) break;
  mlog(`waiting for slot (${active}/${MAX_OPEN} open)`);
  await new Promise(r => setTimeout(r, 3000));
}

// Claim slot
writeFileSync(LOCK_FILE, '1');

try {
  const cookies = JSON.parse(readFileSync(cookiePath, 'utf8'));
  mlog(`cookies loaded (${cookies.length}), launching browser`);

  const browser = await chromium.launch({
    headless: false,
    args: [
      '--start-maximized',
      '--disable-blink-features=AutomationControlled',
      '--no-default-browser-check',
    ],
  });

  const ctx = await browser.newContext({
    viewport : null,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
    locale   : 'en-US',
    ...(_proxy ? { proxy: _proxy } : {}),
  });

  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  await ctx.addCookies(cookies);

  const page = await ctx.newPage();
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});

  mlog('browser open — waiting for user to close');

  // Wait for browser close
  await browser.waitForEvent('disconnected');

  mlog('browser closed');
} catch (e) {
  mlog(`ERROR: ${e.message}\n${e.stack}`);
} finally {
  try { unlinkSync(LOCK_FILE); }  catch {}
  try { unlinkSync(cookiePath); } catch {}
}
