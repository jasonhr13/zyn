#!/usr/bin/env node
'use strict';

// The recovered farmer is copied verbatim from the reviewed Windows application into every macOS
// build. Apply only the reviewed New Headless changes and reject any future source revision until it
// has been inspected, so an upstream farmer update cannot be silently rewritten by stale patterns.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const file = path.resolve(process.argv[2] || '');
if (!file || !fs.existsSync(file)) {
  console.error('Usage: patch-target-farmer-new-headless.js <shape-farmer.mjs>');
  process.exit(2);
}

const REVIEWED_SOURCE_SHA256 = '4011ec41537a6510a6c3f5f422ba9487ac23257191bb364774447e52cc3b3135';
const raw = fs.readFileSync(file);
const actual = crypto.createHash('sha256').update(raw).digest('hex');
if (actual !== REVIEWED_SOURCE_SHA256) {
  console.error(`Target farmer New Headless patch failed: ${path.basename(file)} source hash ${actual} does not match the reviewed source ${REVIEWED_SOURCE_SHA256}`);
  process.exit(1);
}

const newline = raw.includes(Buffer.from('\r\n')) ? '\r\n' : '\n';
let source = raw.toString('utf8').replace(/\r\n/g, '\n');

function replaceOnce(before, after, label) {
  const first = source.indexOf(before);
  if (first === -1) throw new Error(`Could not find ${label}`);
  if (source.indexOf(before, first + before.length) !== -1) throw new Error(`Found ${label} more than once`);
  source = source.slice(0, first) + after + source.slice(first + before.length);
}

try {
  replaceOnce(
    `const HEADLESS = argOf('headless', 'false') === 'true';`,
    `const HEADLESS = argOf('headless', 'true') === 'true';`,
    'New Headless default',
  );
  replaceOnce(
    `// bundled Chromium needs no channel at all. That is the whole of the "auto-detect" -- a path picker
// would be a worse version of something Playwright already does.`,
    `// bundled Chromium uses Playwright's explicit "chromium" channel. This matters in headless mode:
// without a channel Playwright 1.49+ selects the separate chromium-headless-shell product, while the
// explicit alias launches the regular bundled browser with Chromium's New Headless implementation.`,
    'bundled Chromium channel explanation',
  );
  replaceOnce(
    `{ key: 'chromium', channel: null, realBrand: false },`,
    `{ key: 'chromium', channel: 'chromium', realBrand: false },`,
    'bundled Chromium channel',
  );
  replaceOnce(
    `    if (!b.channel && !b.exe) { found.push(b); continue; }   // bundled Chromium ships with Playwright
`,
    ``,
    'unprobed bundled Chromium shortcut',
  );
  replaceOnce(
    `  if (!found.length) found.push(BROWSER_CANDIDATES[2]);   // bundled Chromium always works`,
    `  if (!found.length) {
    const bundled = BROWSER_CANDIDATES.find((candidate) => candidate.key === 'chromium');
    if (bundled) found.push(bundled);
  }`,
    'bundled Chromium fallback',
  );
  replaceOnce(
    `async function harvestOnce(type, proxy, browser = BROWSERS[0] || BROWSER_CANDIDATES[2], reuse = null, stats = null) {`,
    `async function harvestOnce(type, proxy, browser = BROWSERS[0] || BROWSER_CANDIDATES.find((candidate) => candidate.key === 'chromium'), reuse = null, stats = null) {`,
    'single-harvest bundled Chromium fallback',
  );
  replaceOnce(
    `  // Get the harvest windows out of the operator's face WITHOUT going headless — headless is exactly
  // the signal the persona work exists to avoid. Parking them far off-screen keeps a real compositor,
  // real paint and a real GPU process; the window simply isn't on any monitor. Windows then reports
  // the window as occluded, and Chromium's response to that is to throttle timers, freeze rAF and
  // background the renderer — which would stall Shape's own VM and produce short signatures. The
  // three --disable flags switch that throttling off, so an off-screen harvest runs at the same speed
  // as a visible one. None of them are observable from page JS.`,
    `  // New Headless is the normal mode. Keep the old off-screen compositor path only for an explicit
  // --headless=false diagnostic run, and prevent Chromium from throttling that parked window.`,
    'headed diagnostic explanation',
  );
  replaceOnce(
    `  log(\`broker listening on http://\${HOST}:\${PORT}  (proxies: \${PROXIES.length}, headless: \${HEADLESS}, windows: \${HEADLESS ? 'n/a' : OFFSCREEN ? 'off-screen' : 'visible'})\`);`,
    `  log(\`broker listening on http://\${HOST}:\${PORT}  (proxies: \${PROXIES.length}, display: \${HEADLESS ? 'new-headless' : OFFSCREEN ? 'headed/off-screen' : 'headed/visible'})\`);`,
    'farmer display-mode log',
  );

  const output = newline === '\r\n' ? source.replace(/\n/g, '\r\n') : source;
  fs.writeFileSync(file, output, 'utf8');
  console.log(`Patched Target farmer to Chromium New Headless in ${file}`);
} catch (error) {
  console.error(`Target farmer New Headless patch failed: ${error.message}`);
  process.exit(1);
}
