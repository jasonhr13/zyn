#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  EXTENSION_DIRECTORY,
  EXTENSION_OUTPUT_DIRECTORY,
  METADATA_FILENAME,
  artifactFilename,
  assertCleanExtensionSource,
  createDeterministicZip,
  parseManifest,
  releaseMetadata,
  trackedExtensionFiles,
} = require('./zyn-extension-release-lib.cjs');

const projectRoot = path.resolve(__dirname, '..');
const sourceRoot = path.join(projectRoot, EXTENSION_DIRECTORY);
const outputRoot = path.join(projectRoot, EXTENSION_OUTPUT_DIRECTORY);

function run(command, args) {
  console.log(`$ ${command} ${args.map(value => JSON.stringify(value)).join(' ')}`);
  execFileSync(command, args, { cwd: projectRoot, stdio: 'inherit' });
}

function checkModuleSyntax(file) {
  console.log(`$ ${process.execPath} --input-type=module --check < ${file}`);
  execFileSync(process.execPath, ['--input-type=module', '--check'], {
    cwd: projectRoot,
    input: fs.readFileSync(file),
    stdio: ['pipe', 'inherit', 'inherit'],
  });
}

function main() {
  assertCleanExtensionSource(projectRoot);
  const files = trackedExtensionFiles(projectRoot);
  const manifest = parseManifest(fs.readFileSync(path.join(sourceRoot, 'manifest.json'), 'utf8'));

  if (fs.existsSync(outputRoot)) {
    if (process.env.ZYN_OVERWRITE_RELEASE !== '1') {
      throw new Error([
        `Extension release staging already exists at ${outputRoot}.`,
        'Inspect it, then rerun with ZYN_OVERWRITE_RELEASE=1 to replace generated release files.',
      ].join(' '));
    }
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
  fs.mkdirSync(outputRoot, { recursive: true });

  run(process.execPath, [path.join(__dirname, 'harvester-extension-ui-smoke-test.js')]);
  for (const relative of files.filter(file => file.endsWith('.js'))) {
    checkModuleSyntax(path.join(sourceRoot, ...relative.split('/')));
  }

  const filename = artifactFilename(manifest.version);
  const zip = createDeterministicZip({
    sourceRoot,
    files,
    destination: path.join(outputRoot, filename),
  });
  const metadata = releaseMetadata({ version: manifest.version, file: zip });
  fs.writeFileSync(
    path.join(outputRoot, METADATA_FILENAME),
    `${JSON.stringify(metadata, null, 2)}\n`,
    { mode: 0o644 },
  );

  run(process.execPath, [path.join(__dirname, 'verify-zyn-extension-release.cjs')]);
  console.log(`Zyn Harvester ${manifest.version} is ready to upload from ${outputRoot}`);
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  }
}

module.exports = { main };
