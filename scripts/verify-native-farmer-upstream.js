#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const project = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(project, 'config', 'native-farmer-upstream.json'), 'utf8'));
const source = path.join(project, 'native-farmer');

for (const [filename, entry] of Object.entries(manifest.files)) {
  const file = path.join(source, filename);
  assert.ok(fs.existsSync(file), `Missing pinned native farmer source: ${filename}`);
  const actual = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const expected = typeof entry === 'string' ? entry : entry.sha256;
  assert.equal(actual, expected, `${filename} no longer matches pinned source ${manifest.commit}`);
}

console.log(JSON.stringify({
  ok: true,
  commit: manifest.commit,
  files: Object.keys(manifest.files).length,
}, null, 2));
