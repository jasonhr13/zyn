#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const asar = require('../frontend/node_modules/@electron/asar');
const { verifyNativeWebhookBrand } = require('./verify-zyn-native-webhook-brand.cjs');

const TEXT_EXTENSION = /\.(?:[cm]?js|jsx|ts|tsx|json|map|html?|css|txt|md|ya?ml|xml|svg)$/i;
const FIRST_PARTY_EXCLUSION = /(?:^|\/)(?:node_modules|vendor)(?:\/|$)/i;

const LEGACY_TEXT_PATTERNS = Object.freeze([
  ['Polar product identity', /\bPolar(?:[\s_-]*AIO)?\b/i],
  ['Hope product identity', /\bHope\b/i],
  ['Hope runtime protocol', /\bHOPE_[A-Z0-9_]+/],
  ['Hope runtime token header', /x-hope-token/i],
  ['Hope runtime broker identity', /hope-shape-broker/i],
  ['Hope application protocol', /hope:\/\//i],
  ['legacy Secret Lair application identity', /secret[\s_-]+lair[\s_-]+(?:checkout[\s_-]+)?bot/i],
  ['legacy webhook avatar', /media\.discordapp\.net\/attachments\/1443088896396361731\/1487029472778518558\/Adobe_Express_-_file\.png/i],
  // Lowercase x-rcart-* remains a private license-protocol compatibility header. The retired
  // user-facing product spelling is blocked here, and every packaged path is checked case-insensitively.
  ['retired rCart product identity', /\brCart\b/],
]);

const LEGACY_PATH_PATTERNS = Object.freeze([
  ['Polar product identity', /polar/i],
  ['Hope product identity', /hope/i],
  ['retired rCart product identity', /rcart/i],
  ['legacy Secret Lair application identity', /secret[\s_-]+lair[\s_-]+(?:checkout[\s_-]+)?bot/i],
]);

const EXPECTED_BOT_WEBHOOK_SENDERS = Object.freeze([
  'pbandai-buyer.cjs',
  'secret-lair-browserless.mjs',
  'shared.mjs',
]);

function normalizeRelative(file) {
  return file.replaceAll(path.sep, '/').replace(/^\/+/, '');
}

function isFirstPartyText(relative) {
  const normalized = normalizeRelative(relative);
  return TEXT_EXTENSION.test(normalized) && !FIRST_PARTY_EXCLUSION.test(normalized);
}

function assertNoLegacyBrand(source, label) {
  for (const [description, pattern] of LEGACY_TEXT_PATTERNS) {
    const match = pattern.exec(source);
    assert.equal(
      match,
      null,
      `${label} contains ${description}${match ? ` (${JSON.stringify(match[0])})` : ''}`,
    );
  }
}

function assertNoLegacyPath(relative, label) {
  for (const [description, pattern] of LEGACY_PATH_PATTERNS) {
    const match = pattern.exec(relative);
    assert.equal(
      match,
      null,
      `${label} contains ${description} in a packaged path${match ? ` (${JSON.stringify(match[0])})` : ''}`,
    );
  }
}

function walkFirstPartyPaths(root) {
  const paths = [];
  function walk(directory, relativeDirectory = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = normalizeRelative(path.join(relativeDirectory, entry.name));
      if (FIRST_PARTY_EXCLUSION.test(relative)) continue;
      paths.push(relative);
      if (entry.isDirectory()) walk(path.join(directory, entry.name), relative);
    }
  }
  walk(root);
  return paths;
}

function walkFirstPartyTextFiles(root, label) {
  assert.equal(fs.existsSync(root), true, `Missing ${label}: ${root}`);
  const files = [];

  function walk(directory, relativeDirectory = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = normalizeRelative(path.join(relativeDirectory, entry.name));
      if (FIRST_PARTY_EXCLUSION.test(relative)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute, relative);
      } else if (entry.isFile() && isFirstPartyText(relative)) {
        files.push({ relative, source: fs.readFileSync(absolute, 'utf8') });
      }
    }
  }

  walk(root);
  return files;
}

function readFirstPartyAsarText(archive) {
  assert.equal(fs.existsSync(archive), true, `Missing renderer archive: ${archive}`);
  const entries = asar.listPackage(archive);
  const embeddedBackend = entries.find(entry => /^\/backend(?:\/|$)/i.test(entry));
  assert.equal(
    embeddedBackend,
    undefined,
    `${archive} contains an obsolete embedded backend at ${embeddedBackend}`,
  );

  const files = [];
  for (const listed of entries) {
    const relative = normalizeRelative(listed);
    const selected = relative === 'package.json'
      || relative.startsWith('public/')
      || relative.startsWith('build/');
    if (!selected || !isFirstPartyText(relative)) continue;
    files.push({ relative, source: asar.extractFile(archive, relative).toString('utf8') });
  }
  return { entries, files };
}

function requiredSource(files, relative, label) {
  const found = files.find(file => file.relative === relative);
  assert.ok(found, `${label} is missing ${relative}`);
  return found.source;
}

function hasLiteralProperty(source, key, value) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedValue = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:["']?${escapedKey}["']?)\\s*:\\s*["']${escapedValue}["']`).test(source);
}

function assertExplicitZynWebhookIdentity(source, label) {
  assert.equal(
    hasLiteralProperty(source, 'username', 'Zyn'),
    true,
    `${label} does not explicitly set the Discord webhook username to Zyn`,
  );
  assert.equal(
    hasLiteralProperty(source, 'avatar_url', 'https://zynbot.app/zyn-icon.png'),
    true,
    `${label} does not explicitly set the Discord webhook avatar to Zyn`,
  );

  const footerBodies = [...source.matchAll(/(?:["']?footer["']?)\s*:\s*\{([^{}]{0,1000})\}/g)]
    .map(match => match[1]);
  assert.equal(
    footerBodies.some(footer => hasLiteralProperty(footer, 'text', 'Zyn')
      && hasLiteralProperty(footer, 'icon_url', 'https://zynbot.app/zyn-icon.png')),
    true,
    `${label} does not explicitly set the Discord webhook footer text and icon to Zyn`,
  );
}

function assertPackageIdentity(source, label) {
  let parsed;
  assert.doesNotThrow(() => { parsed = JSON.parse(source); }, `${label} is not valid JSON`);
  assert.equal(parsed.name, 'zyn', `${label} package name must be zyn`);
  assert.equal(parsed.productName, 'Zyn', `${label} productName must be Zyn`);
  assert.equal(parsed.description, 'Zyn Checkout Automation', `${label} description must be Zyn Checkout Automation`);
}

function assertBackupIdentity(electronSource, dataManagerSource, label) {
  assert.match(electronSource, /title\s*:\s*["']Export Zyn data["']/, `${label} has no Zyn export dialog title`);
  assert.match(electronSource, /title\s*:\s*["']Import Zyn data["']/, `${label} has no Zyn import dialog title`);
  assert.match(electronSource, /zyn-backup-\$\{stamp\}\.json/, `${label} has no Zyn backup filename`);
  assert.equal(
    hasLiteralProperty(dataManagerSource, 'app', 'zyn'),
    true,
    `${label} does not emit the Zyn backup identity`,
  );
  assert.match(dataManagerSource, /Not a Zyn export file\./, `${label} has no Zyn import validation message`);
}

function assertTargetHarvesterIdentity(source, label) {
  assert.match(source, /<title>\s*Zyn\s*<\/title>/i, `${label} title must be Zyn`);
  assert.match(source, /<div\s+class=["'][^"']*\bharvest-cover\b[^"']*["'][^>]*>/i,
    `${label} does not contain the branded harvester cover`);
  assert.match(source, /<div\s+class=["'][^"']*\bzyn-mark\b[^"']*["'][^>]*>\s*Zyn\s*<\/div>/i,
    `${label} harvester cover does not display Zyn`);
}

function assertRendererIdentity(files, label) {
  const index = requiredSource(files, 'build/index.html', label);
  assert.match(index, /<title>\s*Zyn\s*<\/title>/i, `${label}/build/index.html title must be Zyn`);
  const rendererScripts = files.filter(file => /^build\/.*\.[cm]?js$/i.test(file.relative));
  assert.ok(rendererScripts.length > 0, `${label} has no packaged renderer JavaScript`);
  assert.equal(
    rendererScripts.some(file => /\bZyn\b/.test(file.source)),
    true,
    `${label} renderer JavaScript does not visibly identify Zyn`,
  );
}

function sha256(body) {
  return crypto.createHash('sha256').update(body).digest('hex');
}

function assertRendererIcon(archive, label) {
  const expected = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'public', 'zyn-icon.png'));
  let packaged;
  assert.doesNotThrow(() => { packaged = asar.extractFile(archive, 'build/zyn-icon.png'); },
    `${label}/build/zyn-icon.png is missing`);
  assert.equal(
    sha256(packaged),
    sha256(expected),
    `${label}/build/zyn-icon.png does not match the reviewed Zyn icon`,
  );
}

function containsDiscordWebhookEndpoint(source) {
  return /api(?:\\?\/)+webhooks/i.test(source);
}

function verifyZynPackagedBrand({ resources, engineFile, label = resources }) {
  const resolvedResources = path.resolve(resources);
  const archive = path.join(resolvedResources, 'app-original.asar');
  const asarResult = readFirstPartyAsarText(archive);
  const appFiles = walkFirstPartyTextFiles(path.join(resolvedResources, 'app'), 'Resources/app');
  const botFiles = walkFirstPartyTextFiles(path.join(resolvedResources, 'bot'), 'Resources/bot');

  for (const listed of asarResult.entries) {
    const relative = normalizeRelative(listed);
    if (!FIRST_PARTY_EXCLUSION.test(relative)) assertNoLegacyPath(relative, `${label} ASAR/${relative}`);
  }
  for (const relative of walkFirstPartyPaths(path.join(resolvedResources, 'app'))) {
    assertNoLegacyPath(relative, `${label} Resources/app/${relative}`);
  }
  for (const relative of walkFirstPartyPaths(path.join(resolvedResources, 'bot'))) {
    assertNoLegacyPath(relative, `${label} Resources/bot/${relative}`);
  }

  for (const file of asarResult.files) assertNoLegacyBrand(file.source, `${label} ASAR/${file.relative}`);
  for (const file of appFiles) assertNoLegacyBrand(file.source, `${label} Resources/app/${file.relative}`);
  for (const file of botFiles) assertNoLegacyBrand(file.source, `${label} Resources/bot/${file.relative}`);

  assertPackageIdentity(
    requiredSource(asarResult.files, 'package.json', `${label} ASAR`),
    `${label} ASAR/package.json`,
  );
  assertRendererIdentity(asarResult.files, `${label} ASAR`);
  assertRendererIcon(archive, `${label} ASAR`);
  assertBackupIdentity(
    requiredSource(asarResult.files, 'public/electron.js', `${label} ASAR`),
    requiredSource(asarResult.files, 'public/helpers/data-manager.js', `${label} ASAR`),
    `${label} backup flow`,
  );
  assertTargetHarvesterIdentity(
    requiredSource(botFiles, 'target-atc-v2.html', `${label} Resources/bot`),
    `${label} Resources/bot/target-atc-v2.html`,
  );

  for (const relative of EXPECTED_BOT_WEBHOOK_SENDERS) {
    assertExplicitZynWebhookIdentity(
      requiredSource(botFiles, relative, `${label} Resources/bot`),
      `${label} Resources/bot/${relative}`,
    );
  }
  const discoveredBotWebhookSenders = botFiles.filter(file => containsDiscordWebhookEndpoint(file.source));
  for (const file of discoveredBotWebhookSenders) {
    assertExplicitZynWebhookIdentity(file.source, `${label} Resources/bot/${file.relative}`);
  }
  assertExplicitZynWebhookIdentity(
    requiredSource(asarResult.files, 'public/helpers/checkout-reporter.js', `${label} ASAR`),
    `${label} ASAR/public/helpers/checkout-reporter.js`,
  );

  verifyNativeWebhookBrand(engineFile);

  return {
    archive,
    asarTextFiles: asarResult.files.length,
    appTextFiles: appFiles.length,
    botTextFiles: botFiles.length,
    botWebhookSenders: discoveredBotWebhookSenders.map(file => file.relative).sort(),
  };
}

module.exports = {
  EXPECTED_BOT_WEBHOOK_SENDERS,
  LEGACY_PATH_PATTERNS,
  LEGACY_TEXT_PATTERNS,
  assertBackupIdentity,
  assertExplicitZynWebhookIdentity,
  assertNoLegacyBrand,
  assertNoLegacyPath,
  assertPackageIdentity,
  assertRendererIdentity,
  assertRendererIcon,
  assertTargetHarvesterIdentity,
  verifyZynPackagedBrand,
};
