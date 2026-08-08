#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const projectDirectory = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(projectDirectory, 'config', 'upstream-license.json'), 'utf8'));
const verified = [];

for (const [relativePath, expected] of Object.entries(manifest.files)) {
  const filePath = path.join(projectDirectory, relativePath);
  assert.equal(fs.statSync(filePath).isFile(), true, `${relativePath} is missing`);
  const actual = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  assert.equal(actual, expected, `${relativePath} differs from pinned source ${manifest.commit}`);
  verified.push(relativePath);
}

console.log(JSON.stringify({
  ok: true,
  commit: manifest.commit,
  exactFiles: verified.length,
}, null, 2));
