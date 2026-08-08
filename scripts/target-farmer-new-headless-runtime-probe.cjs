#!/usr/bin/env node
'use strict';

// Run this with the packaged Windows node.exe through the bundled Wine runtime. It is intentionally
// local-only: no navigation leaves the machine. Playwright's pw:browser log names the executable,
// which lets the verifier distinguish regular Chromium from chromium-headless-shell.
const assert = require('assert/strict');

const playwrightModule = process.argv[2];
const browsersPath = process.argv[3];
if (!playwrightModule || !browsersPath) {
  console.error('Usage: node.exe target-farmer-new-headless-runtime-probe.cjs <playwright module> <ms-playwright directory>');
  process.exit(2);
}

process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath;
const { chromium } = require(playwrightModule);

(async () => {
  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<title>Hope New Headless</title><main>ready</main>');
    const result = await page.evaluate(() => ({
      title: document.title,
      text: document.querySelector('main')?.textContent,
      userAgent: navigator.userAgent,
    }));
    assert.equal(result.title, 'Hope New Headless');
    assert.equal(result.text, 'ready');
    console.log(JSON.stringify({ ok: true, browserVersion: browser.version(), ...result }, null, 2));
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error && error.stack || error);
  process.exit(1);
});
