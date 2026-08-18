#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const LEGACY_MARKERS = Object.freeze([
  ['Polar Go module path', 'github.com/PolarAIO/Polar-AIO'],
  ['legacy task-log key', 'PolarAIO-Task-Log-v1'],
  ['Polar AIO webhook identity', 'Polar AIO'],
  ['PolarAIO identity', 'PolarAIO'],
  ['Polar-AIO identity', 'Polar-AIO'],
  ['Polar_AIO identity', 'Polar_AIO'],
  ['legacy Go module path', 'polar-backend'],
  ['Hope shape-token protocol', 'HOPE_SHAPE_TOKEN'],
  ['Hope shape-port protocol', 'HOPE_SHAPE_PORT'],
  ['Hope parent-watch protocol', 'HOPE_PARENT_WATCH'],
  ['Hope owner-pid protocol', 'HOPE_OWNER_PID'],
  ['Hope Target shape URL protocol', 'HOPE_TARGET_SHAPE_URL'],
  ['Hope shape-token header', 'x-hope-token'],
  ['Hope shape-broker identity', 'hope-shape-broker'],
  ['Hope broker error identity', 'Hope broker error'],
  ['Hope product identity', 'Hope'],
  ['legacy Secret Lair application identity', 'Secret Lair Bot'],
  ['legacy webhook avatar', 'https://media.discordapp.net/attachments/1443088896396361731/1487029472778518558/Adobe_Express_-_file.png'],
]);

// Pokémon Center still depends on the queue-status service. Walmart's recovered PX quota helper
// also contains the legacy check URL, although a Zyn child has no Polar license key and therefore
// returns before making that request. Neither value is rendered. Keep the allowlist exact until
// both dependencies have Zyn-owned replacements.
const ALLOWED_INTERNAL_POLAR_MARKERS = Object.freeze([
  'https://polar-wss-production.up.railway.app/sites/PokemonCenter/queue-status',
  'https://polar-wss-production.up.railway.app/px-solve/check',
]);

const REQUIRED_MARKERS = Object.freeze([
  ['Zyn webhook avatar', 'https://zynbot.app/zyn-icon.png'],
  ['Zyn Go module path', 'zynbot.app/engine'],
  ['Zyn shape-token protocol', 'ZYN_SHAPE_TOKEN'],
  ['Zyn shape-token header', 'x-zyn-token'],
  ['Zyn task-log key', 'Zyn-Task-Log-v1'],
  ['Zyn telemetry service', 'zyn-engine'],
  ['monitor bandwidth envelope', 'monitor-bandwidth'],
  ['monitor TLS wire measurement', 'tls-client-wire'],
]);

function verifyNativeWebhookBrandBuffer(body, label = 'native engine') {
  assert.ok(Buffer.isBuffer(body), `${label} must be supplied as a Buffer`);
  for (const [description, marker] of LEGACY_MARKERS) {
    assert.equal(
      body.includes(Buffer.from(marker)),
      false,
      `${label} contains ${description} (${JSON.stringify(marker)})`,
    );
  }
  let productText = body.toString('latin1');
  const foundRequired = REQUIRED_MARKERS.filter(([, marker]) => body.includes(Buffer.from(marker)));
  // Garble -literals hides Zyn protocol strings. A fully obfuscated engine is accepted when none
  // of the required markers remain and no retired Polar/Hope identity is readable either.
  if (foundRequired.length && foundRequired.length !== REQUIRED_MARKERS.length) {
    const missing = REQUIRED_MARKERS.filter(([, marker]) => !body.includes(Buffer.from(marker)));
    assert.equal(
      missing.length,
      0,
      `${label} does not contain ${missing[0][0]} (${JSON.stringify(missing[0][1])})`,
    );
  }
  if (foundRequired.length === REQUIRED_MARKERS.length) {
    for (const marker of ALLOWED_INTERNAL_POLAR_MARKERS) {
      productText = productText.split(marker).join('');
    }
    assert.equal(
      /polar/i.test(productText),
      false,
      `${label} contains an unexpected Polar identity outside the allowlisted internal queue endpoint`,
    );
  } else {
    productText = body.toString('latin1');
    assert.equal(
      /polar/i.test(productText),
      false,
      `${label} contains an unexpected Polar identity`,
    );
  }
  // Raw substring matching cannot distinguish the retired product name from Walmart's legitimate
  // Go method name ClearCart. Require word boundaries for this one marker.
  assert.equal(
    /(?:^|[^A-Za-z])rCart(?:[^A-Za-z]|$)/i.test(productText),
    false,
    `${label} contains retired rCart product identity`,
  );
}

function verifyNativeGoBuildMetadataOutput(output, label = 'native engine') {
  assert.match(
    output,
    /^\s*path\s+zynbot\.app\/engine(?:\/\S+)?\s*$/m,
    `${label} Go command path is not rooted at zynbot.app/engine`,
  );
  assert.match(
    output,
    /^\s*mod\s+zynbot\.app\/engine(?:\s|$)/m,
    `${label} Go module is not zynbot.app/engine`,
  );
  assert.doesNotMatch(
    output,
    /github\.com\/PolarAIO\/Polar-AIO|polar-backend|\bHope\b|\bHOPE_/i,
    `${label} Go build metadata contains a legacy engine identity`,
  );
}

function verifyNativeGoBuildMetadata(file) {
  const result = spawnSync('go', ['version', '-m', file], { encoding: 'utf8' });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  if (
    result.error
    || result.status !== 0
    || !/zynbot\.app\/engine/.test(result.stdout || '')
    || /not a Go executable|build info/i.test(output)
  ) {
    // Garble strips or encrypts Go build info. The binary still must not name Polar/Hope.
    const body = fs.readFileSync(path.resolve(file));
    assert.doesNotMatch(
      body.toString('latin1'),
      /github\.com\/PolarAIO\/Polar-AIO|polar-backend|\bHope\b|\bHOPE_/i,
      `${file} contains a legacy engine identity`,
    );
    return;
  }
  verifyNativeGoBuildMetadataOutput(result.stdout, file);
}

function verifyNativeWebhookBrand(file) {
  const resolved = path.resolve(file);
  verifyNativeWebhookBrandBuffer(fs.readFileSync(resolved), resolved);
  verifyNativeGoBuildMetadata(resolved);
}

if (require.main === module) {
  const files = process.argv.slice(2).map(file => path.resolve(file));
  if (!files.length) {
    console.error('Usage: verify-zyn-native-webhook-brand.cjs <native-engine> [...]');
    process.exit(2);
  }
  for (const file of files) {
    verifyNativeWebhookBrand(file);
    console.log(`Verified Zyn native runtime and webhook branding in ${file}`);
  }
}

module.exports = {
  ALLOWED_INTERNAL_POLAR_MARKERS,
  LEGACY_MARKERS,
  REQUIRED_MARKERS,
  verifyNativeGoBuildMetadata,
  verifyNativeGoBuildMetadataOutput,
  verifyNativeWebhookBrand,
  verifyNativeWebhookBrandBuffer,
};
