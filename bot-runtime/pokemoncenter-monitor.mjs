// Pokemon Center — single-session queue monitor. Launches ONE visible browser on the chosen
// proxy/account, sits in the virtual queue until redirected through, then waits for a live SKU
// to be pushed down over stdin. Add-to-cart/checkout are intentionally not implemented yet — this
// stops at "queue passed, SKU set" per the current scope.
//
// Run: node bot/pokemoncenter-monitor.mjs --config=<path> --id=<instanceId> --profile-dir=<dir>

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { argOf, createBotContext } from './shared.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CONFIG_PATH = argOf('config', '');
const INSTANCE_ID = argOf('id', 'default');
const PROFILE_DIR = argOf('profile-dir', path.join(__dirname, `pokemoncenter-profile-${INSTANCE_ID}`));

let cfg = { proxy: '', queueUrl: 'https://www.pokemoncenter.com/', account: '' };
try {
  if (CONFIG_PATH) cfg = { ...cfg, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
} catch {}

const { log } = createBotContext({ dataDir: __dirname, botName: 'pokemoncenter', signupId: INSTANCE_ID });
const status = (state, detail = '') => console.log(`@@STATUS ${state}|${detail}`);

function parseProxy(raw) {
  if (!raw) return null;
  const [host, port, username, password] = String(raw).split(':');
  if (!host || !port) return null;
  const proxy = { server: `http://${host}:${port}` };
  if (username) proxy.username = username;
  if (password) proxy.password = password;
  return proxy;
}

// Queue-room detection is text-based (site markup for this is unstable) — the copy on the wait
// page consistently mentions "virtual queue"; once that's gone from the page, we've been let through.
async function isInQueue(page) {
  try {
    const text = await page.evaluate(() => document.body?.innerText || '');
    return /virtual queue/i.test(text);
  } catch { return false; }
}

async function waitEstimate(page) {
  try {
    const text = await page.evaluate(() => document.body?.innerText || '');
    const m = text.match(/Estimated wait time:\s*([0-9:]+)/i);
    return m ? m[1] : '';
  } catch { return ''; }
}

let currentSku = '';

// Live control channel from the main process (Set SKU button, future Force/Stop buttons).
function listenStdin() {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const m = line.match(/^@@SETSKU\s+(\S+)/);
    if (m) {
      currentSku = m[1];
      log(`SKU set: ${currentSku}`);
      status('ready', `sku:${currentSku}`);
    }
  });
}

async function main() {
  log('═══════════════════════════════════════════');
  log(`Pokemon Center monitor — instance ${INSTANCE_ID}`);
  log(`Queue URL: ${cfg.queueUrl}`);
  log('═══════════════════════════════════════════');
  status('starting');
  listenStdin();

  const proxy = parseProxy(cfg.proxy);
  if (proxy) log(`Using proxy: ${proxy.server}`);

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false, proxy: proxy || undefined, viewport: null, args: ['--no-sandbox'],
  });
  const page = context.pages()[0] || await context.newPage();
  await page.goto(cfg.queueUrl, { waitUntil: 'domcontentloaded' }).catch(e => log(`Navigation warning: ${e.message}`));

  status('queue', 'waiting');
  let lastEstimate = '';
  const pollTimer = setInterval(async () => {
    try {
      if (await isInQueue(page)) {
        const est = await waitEstimate(page);
        if (est && est !== lastEstimate) { lastEstimate = est; log(`Still queued — estimated wait ${est}`); }
        status('queue', `waiting${est ? ' ' + est : ''}`);
      } else {
        clearInterval(pollTimer);
        log('Queue passed — through to the site.');
        status('queue', 'passed');
        status('ready', currentSku ? `sku:${currentSku}` : '');
      }
    } catch {}
  }, 5000);

  // Stay alive until the user closes the browser or the parent process kills this one.
  await new Promise((resolve) => { context.on('close', resolve); });
  clearInterval(pollTimer);
  log('Browser closed.');
  status('stopped');
}

main().catch(e => {
  log(`FATAL: ${e.stack || e.message}`);
  status('error', e.message);
  process.exit(1);
});
