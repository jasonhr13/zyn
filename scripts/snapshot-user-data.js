#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectDir = path.resolve(__dirname, '..');

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
const source = path.resolve(option(
  '--source',
  process.env.ZYN_USER_DATA_DIR
    || path.join(os.homedir(), 'Library', 'Application Support', 'secret-lair-bot'),
));
const outputRoot = path.resolve(option(
  '--output-root',
  path.join(projectDir, '.local', 'user-data-snapshots'),
));

if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
  console.error(`Zyn user-data directory not found: ${source}`);
  process.exit(2);
}
if (outputRoot === source || outputRoot.startsWith(`${source}${path.sep}`)) {
  console.error('Snapshot output cannot be inside the source user-data directory.');
  process.exit(2);
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function copyStable(sourceFile, targetFile) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = fs.statSync(sourceFile);
    const bytes = fs.readFileSync(sourceFile);
    const after = fs.statSync(sourceFile);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) continue;
    fs.writeFileSync(targetFile, bytes, { mode: 0o600 });
    return;
  }
  throw new Error(`File changed repeatedly while being copied: ${path.basename(sourceFile)}`);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
fs.mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
fs.chmodSync(outputRoot, 0o700);
const finalPath = path.join(outputRoot, `Zyn-user-data-${stamp}`);
const partialPath = `${finalPath}.${process.pid}.partial`;
fs.mkdirSync(partialPath, { mode: 0o700 });

try {
  const names = fs.readdirSync(source)
    .filter(name => name.endsWith('.json'))
    .filter(name => fs.statSync(path.join(source, name)).isFile())
    .sort();
  if (!names.length) throw new Error('No top-level JSON data files were found to snapshot.');

  const files = [];
  for (const name of names) {
    const sourceFile = path.join(source, name);
    const targetFile = path.join(partialPath, name);
    copyStable(sourceFile, targetFile);
    const stat = fs.statSync(targetFile);
    files.push({ name, bytes: stat.size, sha256: sha256(targetFile) });
  }

  const manifest = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    source,
    files,
  };
  fs.writeFileSync(
    path.join(partialPath, 'snapshot-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600 },
  );
  fs.renameSync(partialPath, finalPath);
  console.log(JSON.stringify({ ok: true, snapshot: finalPath, files: files.length }, null, 2));
} catch (error) {
  fs.rmSync(partialPath, { recursive: true, force: true });
  console.error(error.message);
  process.exit(1);
}
