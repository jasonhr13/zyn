#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  EXTENSION_DIRECTORY,
  bumpManifestSource,
} = require('./zyn-extension-release-lib.cjs');

const projectRoot = path.resolve(__dirname, '..');
const manifestPath = path.join(projectRoot, EXTENSION_DIRECTORY, 'manifest.json');

function main(argv = process.argv.slice(2)) {
  const unexpected = argv.filter(value => value !== '--dry-run');
  if (unexpected.length || argv.filter(value => value === '--dry-run').length > 1) {
    console.error('Usage: node scripts/bump-zyn-extension-version.cjs [--dry-run]');
    process.exitCode = 2;
    return;
  }

  const result = bumpManifestSource(fs.readFileSync(manifestPath, 'utf8'));
  if (!argv.includes('--dry-run')) fs.writeFileSync(manifestPath, result.source, 'utf8');
  console.log(`${result.previous} -> ${result.next}${argv.includes('--dry-run') ? ' (dry run)' : ''}`);
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    console.error(error.message || error);
    process.exitCode = 1;
  }
}

module.exports = { main };
