#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const project = path.resolve(__dirname, '..');
const goRoot = process.env.POLAR_BACKEND_SOURCE
  ? path.resolve(process.env.POLAR_BACKEND_SOURCE)
  : path.resolve(project, '..', 'polar-backend-source');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'zyn-webhook-brand-'));

try {
  const botDir = path.join(temporary, 'bot');
  fs.mkdirSync(botDir);
  for (const name of ['pbandai-buyer.cjs', 'shared.mjs']) {
    fs.copyFileSync(
      path.join(project, 'dist', 'Zyn-Runtime-Base.app', 'Contents', 'Resources', 'bot', name),
      path.join(botDir, name),
    );
  }
  execFileSync(process.execPath, [path.join(__dirname, 'patch-zyn-bot-webhook-brand.cjs'), botDir], {
    stdio: 'inherit',
  });
  for (const name of ['pbandai-buyer.cjs', 'shared.mjs']) {
    const branded = fs.readFileSync(path.join(botDir, name), 'utf8');
    assert.doesNotMatch(branded, /username\s*:\s*["'](?:Hope|Polar AIO)["']/);
    assert.match(branded, /username\s*:\s*["']Zyn["']/);
    assert.match(branded, /footer\s*:\s*\{\s*text\s*:\s*["']Zyn["']/);
    assert.match(branded, /https:\/\/zynbot\.app\/zyn-icon\.png/);
  }

  execFileSync('go', [
    'test', '-tags', 'zyn', './bot-base/task/webhook',
  ], { cwd: goRoot, stdio: 'inherit' });

  console.log('All Settings webhook paths use the Zyn username, footer, and avatar.');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
