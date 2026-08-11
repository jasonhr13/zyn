#!/usr/bin/env node
'use strict';

const path = require('node:path');
const {
  EXTENSION_DIRECTORY,
  EXTENSION_OUTPUT_DIRECTORY,
  trackedExtensionFiles,
  verifyExtensionRelease,
} = require('./zyn-extension-release-lib.cjs');

const projectRoot = path.resolve(__dirname, '..');

function main() {
  const result = verifyExtensionRelease({
    sourceRoot: path.join(projectRoot, EXTENSION_DIRECTORY),
    files: trackedExtensionFiles(projectRoot),
    outputRoot: path.join(projectRoot, EXTENSION_OUTPUT_DIRECTORY),
  });
  console.log(
    `Zyn Harvester ${result.metadata.version} release verification passed `
    + `(${result.entries} files, sha256 ${result.metadata.sha256}).`,
  );
  return result;
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  }
}

module.exports = { main };
