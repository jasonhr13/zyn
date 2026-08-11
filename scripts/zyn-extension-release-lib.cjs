#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const EXTENSION_NAME = 'Zyn Harvester';
const EXTENSION_DIRECTORY = path.join('chrome-extension', 'harvester');
const EXTENSION_OUTPUT_DIRECTORY = path.join('release', 'dist', 'extension');
const METADATA_FILENAME = 'latest.json';
const METADATA_SCHEMA_VERSION = 1;
const NORMALIZED_ARCHIVE_DATE = new Date(2000, 0, 1, 0, 0, 0);
const MAX_COMMAND_OUTPUT = 32 * 1024 * 1024;

function executable(preferred, fallback) {
  return fs.existsSync(preferred) ? preferred : fallback;
}

const ZIP = executable('/usr/bin/zip', 'zip');
const UNZIP = executable('/usr/bin/unzip', 'unzip');

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: options.encoding === undefined ? 'utf8' : options.encoding,
    maxBuffer: MAX_COMMAND_OUTPUT,
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

function validChromeVersion(value) {
  const text = String(value || '');
  const parts = text.split('.');
  if (parts.length < 1 || parts.length > 4) return false;
  if (parts.every(part => part === '0')) return false;
  return parts.every(part => /^(?:0|[1-9]\d*)$/.test(part)
    && Number(part) >= 0 && Number(part) <= 65535);
}

function assertChromeVersion(value, label = 'extension version') {
  if (!validChromeVersion(value)) {
    throw new Error(`${label} must contain one to four Chrome version integers from 0 to 65535.`);
  }
  return String(value);
}

function nextPatchVersion(value) {
  const version = assertChromeVersion(value);
  const parts = version.split('.').map(Number);
  if (parts.length !== 3) {
    throw new Error(`Automatic patch bumps require a three-part version; found ${version}.`);
  }
  if (parts[2] >= 65535) {
    throw new Error(`Cannot patch-bump ${version}; choose a new minor version explicitly.`);
  }
  parts[2] += 1;
  return parts.join('.');
}

function parseManifest(source, label = 'manifest.json') {
  let manifest;
  try {
    manifest = JSON.parse(source);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`${label} must contain an object.`);
  }
  if (manifest.name !== EXTENSION_NAME) throw new Error(`${label} must identify ${EXTENSION_NAME}.`);
  if (manifest.manifest_version !== 3) throw new Error(`${label} must use Manifest V3.`);
  assertChromeVersion(manifest.version, `${label} version`);
  return manifest;
}

function bumpManifestSource(source) {
  const manifest = parseManifest(source);
  const next = nextPatchVersion(manifest.version);
  const versionProperty = /(^\s*"version"\s*:\s*")([^"\r\n]+)("\s*,?\s*$)/gm;
  const matches = [...source.matchAll(versionProperty)];
  if (matches.length !== 1 || matches[0][2] !== manifest.version) {
    throw new Error(`Expected exactly one manifest version property for ${manifest.version}.`);
  }
  return {
    previous: manifest.version,
    next,
    source: source.replace(versionProperty, `$1${next}$3`),
  };
}

function artifactFilename(version) {
  return `Zyn-Harvester-${assertChromeVersion(version)}.zip`;
}

function assertSafeRelativePath(value) {
  const relative = String(value || '');
  if (!relative || path.isAbsolute(relative) || relative.startsWith('-') || relative.includes('\\')
    || /[\0\r\n]/.test(relative)) {
    throw new Error(`Unsafe extension release path: ${JSON.stringify(relative)}`);
  }
  const parts = relative.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) {
    throw new Error(`Unsafe extension release path: ${JSON.stringify(relative)}`);
  }
  return relative;
}

function trackedExtensionFiles(projectRoot) {
  const root = path.resolve(projectRoot);
  const prefix = `${EXTENSION_DIRECTORY.split(path.sep).join('/')}/`;
  const output = run('git', ['ls-files', '-z', '--', prefix], {
    cwd: root,
    encoding: 'buffer',
  });
  const files = output.toString('utf8').split('\0').filter(Boolean).map(file => {
    if (!file.startsWith(prefix)) throw new Error(`Unexpected tracked extension path: ${file}`);
    return assertSafeRelativePath(file.slice(prefix.length));
  }).sort();
  if (!files.includes('manifest.json')) throw new Error('The tracked extension payload is missing manifest.json.');
  if (!files.length) throw new Error('No tracked extension files were found.');
  return files;
}

function assertCleanExtensionSource(projectRoot) {
  const output = run('git', [
    'status', '--porcelain=v1', '--untracked-files=all', '--',
    EXTENSION_DIRECTORY.split(path.sep).join('/'),
  ], { cwd: projectRoot }).trim();
  if (output) {
    throw new Error([
      'The Chrome extension source is not clean. Commit every extension file before packaging:',
      output,
    ].join('\n'));
  }
}

function assertRegularPayloadFiles(sourceRoot, files) {
  const root = fs.realpathSync(sourceRoot);
  for (const relative of files) {
    assertSafeRelativePath(relative);
    const file = path.join(root, ...relative.split('/'));
    const item = fs.lstatSync(file);
    if (!item.isFile() || item.isSymbolicLink()) {
      throw new Error(`Extension release payload must contain regular files only: ${relative}`);
    }
    const resolved = fs.realpathSync(file);
    const inside = path.relative(root, resolved);
    if (inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) {
      throw new Error(`Extension release payload escapes its source root: ${relative}`);
    }
  }
}

function createDeterministicZip({ sourceRoot, files, destination }) {
  const normalizedFiles = [...files].map(assertSafeRelativePath).sort();
  if (!normalizedFiles.length) throw new Error('Cannot create an empty extension release.');
  if (new Set(normalizedFiles).size !== normalizedFiles.length) {
    throw new Error('Extension release file list contains duplicates.');
  }
  assertRegularPayloadFiles(sourceRoot, normalizedFiles);

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'zyn-extension-release-'));
  const output = path.resolve(destination);
  try {
    for (const relative of normalizedFiles) {
      const source = path.join(sourceRoot, ...relative.split('/'));
      const staged = path.join(temporary, ...relative.split('/'));
      fs.mkdirSync(path.dirname(staged), { recursive: true, mode: 0o755 });
      fs.writeFileSync(staged, fs.readFileSync(source), { mode: 0o644 });
      fs.chmodSync(staged, 0o644);
      fs.utimesSync(staged, NORMALIZED_ARCHIVE_DATE, NORMALIZED_ARCHIVE_DATE);
    }
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.rmSync(output, { force: true });
    run(ZIP, ['-X', '-q', '-9', output, ...normalizedFiles], { cwd: temporary });
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  return output;
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!bytes) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

function releaseMetadata({ version, file, publishedAt = new Date().toISOString() }) {
  const normalizedVersion = assertChromeVersion(version);
  const date = new Date(publishedAt);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== publishedAt) {
    throw new Error('Extension release publishedAt must be a canonical ISO-8601 timestamp.');
  }
  return {
    schemaVersion: METADATA_SCHEMA_VERSION,
    name: EXTENSION_NAME,
    version: normalizedVersion,
    filename: artifactFilename(normalizedVersion),
    size: fs.statSync(file).size,
    sha256: sha256File(file),
    publishedAt,
  };
}

const METADATA_KEYS = Object.freeze([
  'filename', 'name', 'publishedAt', 'schemaVersion', 'sha256', 'size', 'version',
]);

function validateReleaseMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Extension release metadata must contain an object.');
  }
  const keys = Object.keys(value).sort();
  if (JSON.stringify(keys) !== JSON.stringify(METADATA_KEYS)) {
    throw new Error(`Extension release metadata must contain exactly: ${METADATA_KEYS.join(', ')}.`);
  }
  if (value.schemaVersion !== METADATA_SCHEMA_VERSION) {
    throw new Error(`Extension release metadata schema must be ${METADATA_SCHEMA_VERSION}.`);
  }
  if (value.name !== EXTENSION_NAME) throw new Error(`Extension release name must be ${EXTENSION_NAME}.`);
  const version = assertChromeVersion(value.version, 'extension release metadata version');
  if (value.filename !== artifactFilename(version)) {
    throw new Error('Extension release filename does not match its version.');
  }
  if (!Number.isSafeInteger(value.size) || value.size <= 0) {
    throw new Error('Extension release size must be a positive safe integer.');
  }
  if (!/^[a-f0-9]{64}$/.test(value.sha256)) {
    throw new Error('Extension release sha256 must be a lowercase SHA-256 digest.');
  }
  const date = new Date(value.publishedAt);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value.publishedAt) {
    throw new Error('Extension release publishedAt must be a canonical ISO-8601 timestamp.');
  }
  return value;
}

function readReleaseMetadata(file) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read extension release metadata ${file}: ${error.message}`);
  }
  return validateReleaseMetadata(value);
}

function archiveEntries(zip) {
  run(UNZIP, ['-tqq', zip]);
  const output = run(UNZIP, ['-Z1', zip]);
  return output.split(/\r?\n/).filter(Boolean).map(assertSafeRelativePath);
}

function archiveFile(zip, relative) {
  return run(UNZIP, ['-p', zip, assertSafeRelativePath(relative)], { encoding: 'buffer' });
}

function verifyExtensionRelease({ sourceRoot, files, outputRoot }) {
  const normalizedFiles = [...files].map(assertSafeRelativePath).sort();
  assertRegularPayloadFiles(sourceRoot, normalizedFiles);
  const manifestSource = fs.readFileSync(path.join(sourceRoot, 'manifest.json'), 'utf8');
  const manifest = parseManifest(manifestSource);
  const metadataPath = path.join(outputRoot, METADATA_FILENAME);
  const metadata = readReleaseMetadata(metadataPath);
  if (metadata.version !== manifest.version) {
    throw new Error(`Release metadata version ${metadata.version} does not match manifest ${manifest.version}.`);
  }
  const zip = path.join(outputRoot, metadata.filename);
  if (!fs.existsSync(zip)) throw new Error(`Missing extension release ZIP: ${zip}`);
  const size = fs.statSync(zip).size;
  const digest = sha256File(zip);
  if (size !== metadata.size) throw new Error('Extension release ZIP size does not match latest.json.');
  if (digest !== metadata.sha256) throw new Error('Extension release ZIP digest does not match latest.json.');

  const entries = archiveEntries(zip);
  if (entries.length !== new Set(entries).size) throw new Error('Extension release ZIP contains duplicate entries.');
  if (JSON.stringify([...entries].sort()) !== JSON.stringify(normalizedFiles)) {
    throw new Error('Extension release ZIP entries do not exactly match the tracked extension payload.');
  }
  if (!entries.includes('manifest.json')) throw new Error('Extension release ZIP must have manifest.json at its root.');

  for (const relative of normalizedFiles) {
    const expected = fs.readFileSync(path.join(sourceRoot, ...relative.split('/')));
    const actual = archiveFile(zip, relative);
    if (!actual.equals(expected)) throw new Error(`Extension release ZIP differs at ${relative}.`);
  }
  const archivedManifest = parseManifest(archiveFile(zip, 'manifest.json').toString('utf8'), 'archived manifest.json');
  if (archivedManifest.version !== metadata.version) {
    throw new Error('Archived extension manifest version does not match latest.json.');
  }
  return { metadata, zip, entries: entries.length };
}

module.exports = {
  EXTENSION_DIRECTORY,
  EXTENSION_NAME,
  EXTENSION_OUTPUT_DIRECTORY,
  METADATA_FILENAME,
  METADATA_SCHEMA_VERSION,
  archiveEntries,
  archiveFile,
  artifactFilename,
  assertChromeVersion,
  assertCleanExtensionSource,
  bumpManifestSource,
  createDeterministicZip,
  nextPatchVersion,
  parseManifest,
  readReleaseMetadata,
  releaseMetadata,
  sha256File,
  trackedExtensionFiles,
  validChromeVersion,
  validateReleaseMetadata,
  verifyExtensionRelease,
};
