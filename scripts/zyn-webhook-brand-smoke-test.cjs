#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const project = path.resolve(__dirname, '..');
const goRoot = process.env.POLAR_BACKEND_SOURCE
  ? path.resolve(process.env.POLAR_BACKEND_SOURCE)
  : path.resolve(project, '..', 'polar-backend-source');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'zyn-webhook-brand-'));
const goEnv = { ...process.env, GOCACHE: process.env.GOCACHE || path.join(temporary, 'go-build-cache') };
const botFiles = ['pbandai-buyer.cjs', 'round1-register.mjs', 'secret-lair-browserless.mjs', 'shared.mjs'];
const webhookFiles = ['pbandai-buyer.cjs', 'secret-lair-browserless.mjs', 'shared.mjs'];

try {
  const botDir = path.join(temporary, 'bot');
  fs.mkdirSync(botDir);
  for (const name of botFiles) {
    fs.copyFileSync(
      path.join(project, 'dist', 'Zyn-Runtime-Base.app', 'Contents', 'Resources', 'bot', name),
      path.join(botDir, name),
    );
  }
  execFileSync(process.execPath, [path.join(__dirname, 'patch-zyn-bot-webhook-brand.cjs'), botDir], {
    stdio: 'inherit',
  });
  for (const name of webhookFiles) {
    const branded = fs.readFileSync(path.join(botDir, name), 'utf8');
    assert.doesNotMatch(branded, /username\s*:\s*["'](?:Hope|Polar AIO)["']/);
    assert.match(branded, /username\s*:\s*["']Zyn["']/);
    assert.match(branded, /footer\s*:\s*\{\s*text\s*:\s*["']Zyn["']/);
    assert.match(branded, /https:\/\/zynbot\.app\/zyn-icon\.png/);
  }
  assert.doesNotMatch(fs.readFileSync(path.join(botDir, 'round1-register.mjs'), 'utf8'), /\bHope\b/i);

  execFileSync('go', [
    'test', '-tags', 'zyn', './bot-base/task/webhook',
  ], { cwd: goRoot, env: goEnv, stdio: 'inherit' });

  for (const [label, tags] of [['without a product tag', ''], ['with conflicting product tags', 'zyn polar']]) {
    const output = path.join(temporary, `unexpected-${tags ? 'dual' : 'untagged'}-engine`);
    const args = ['build', '-o', output];
    if (tags) args.push('-tags', tags);
    args.push('./cmd/zyn-engine');
    const attempt = spawnSync('go', args, { cwd: goRoot, env: goEnv, encoding: 'utf8' });
    assert.notEqual(attempt.status, 0, `Zyn engine unexpectedly built ${label}`);
    assert.equal(fs.existsSync(output), false, `rejected ${label} build left an executable`);
  }

  console.log('All Settings webhook paths use the Zyn username, footer, and avatar.');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
