#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  pruneNativeAddons,
  resolveTarget,
} = require('./prune-zyn-native-addons.cjs');

function write(file, body = 'ok') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zyn-native-prune-'));
  const nodeModules = path.join(root, 'node_modules');
  for (const platform of ['darwin', 'linux', 'win32']) {
    for (const arch of ['arm64', 'x64']) {
      write(path.join(nodeModules, 'onnxruntime-node', 'bin', 'napi-v3', platform, arch, 'onnxruntime_binding.node'));
    }
  }
  for (const name of [
    'sharp-darwin-arm64',
    'sharp-libvips-darwin-arm64',
    'sharp-darwin-x64',
    'sharp-libvips-darwin-x64',
    'sharp-win32-x64',
    'sharp-libvips-win32-x64',
  ]) {
    write(path.join(nodeModules, '@img', name, 'package.json'), '{"name":"@img/' + name + '"}');
  }
  return { root, nodeModules };
}

const { nodeModules } = fixture();
const result = pruneNativeAddons(nodeModules, 'mac', 'arm64', {
  install() { throw new Error('should not download when keepers already exist'); },
});
assert.equal(result.platform, 'darwin');
assert.equal(result.arch, 'arm64');
assert.deepEqual(result.installed, []);
assert.equal(fs.existsSync(path.join(nodeModules, 'onnxruntime-node', 'bin', 'napi-v3', 'darwin', 'arm64', 'onnxruntime_binding.node')), true);
assert.equal(fs.existsSync(path.join(nodeModules, 'onnxruntime-node', 'bin', 'napi-v3', 'darwin', 'x64')), false);
assert.equal(fs.existsSync(path.join(nodeModules, 'onnxruntime-node', 'bin', 'napi-v3', 'linux')), false);
assert.equal(fs.existsSync(path.join(nodeModules, 'onnxruntime-node', 'bin', 'napi-v3', 'win32')), false);
assert.equal(fs.existsSync(path.join(nodeModules, '@img', 'sharp-darwin-arm64', 'package.json')), true);
assert.equal(fs.existsSync(path.join(nodeModules, '@img', 'sharp-libvips-darwin-arm64', 'package.json')), true);
assert.equal(fs.existsSync(path.join(nodeModules, '@img', 'sharp-win32-x64')), false);
assert.equal(fs.existsSync(path.join(nodeModules, '@img', 'sharp-darwin-x64')), false);

const fetched = [];
const missing = fixture();
fs.rmSync(path.join(missing.nodeModules, '@img', 'sharp-darwin-x64'), { recursive: true, force: true });
fs.rmSync(path.join(missing.nodeModules, '@img', 'sharp-libvips-darwin-x64'), { recursive: true, force: true });
const installed = pruneNativeAddons(missing.nodeModules, 'darwin', 'x64', {
  versions: {
    'sharp-darwin-x64': '0.33.5',
    'sharp-libvips-darwin-x64': '1.0.4',
  },
  install(specs, staging) {
    fetched.push({ specs, staging });
    write(path.join(staging, 'node_modules', '@img', 'sharp-darwin-x64', 'package.json'), '{"name":"@img/sharp-darwin-x64"}');
    write(path.join(staging, 'node_modules', '@img', 'sharp-libvips-darwin-x64', 'package.json'), '{"name":"@img/sharp-libvips-darwin-x64"}');
  },
});
assert.deepEqual(fetched[0].specs, ['@img/sharp-darwin-x64@0.33.5', '@img/sharp-libvips-darwin-x64@1.0.4']);
assert.deepEqual(installed.installed, ['sharp-darwin-x64', 'sharp-libvips-darwin-x64']);
assert.equal(fs.existsSync(path.join(missing.nodeModules, '@img', 'sharp-darwin-x64', 'package.json')), true);
assert.equal(fs.existsSync(path.join(missing.nodeModules, 'onnxruntime-node', 'bin', 'napi-v3', 'win32')), false);

assert.throws(
  () => pruneNativeAddons(fixture().nodeModules, 'linux', 'x64'),
  /Unsupported native-addon platform/,
);
assert.equal(resolveTarget('windows', 'amd64').key, 'win32-x64');

console.log(JSON.stringify({
  ok: true,
  prunesOtherPlatforms: true,
  fetchesMissingSharp: true,
}, null, 2));
