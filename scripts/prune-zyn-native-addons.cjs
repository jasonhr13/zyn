#!/usr/bin/env node
'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const projectRoot = path.join(__dirname, '..');
const PLATFORMS = new Set(['darwin', 'win32']);
const ARCHES = new Set(['arm64', 'x64']);
const SHARP_PACKAGES = Object.freeze({
  'darwin-arm64': ['sharp-darwin-arm64', 'sharp-libvips-darwin-arm64'],
  'darwin-x64': ['sharp-darwin-x64', 'sharp-libvips-darwin-x64'],
  'win32-x64': ['sharp-win32-x64', 'sharp-libvips-win32-x64'],
  'win32-arm64': ['sharp-win32-arm64', 'sharp-libvips-win32-arm64'],
});

function fail(message) {
  throw new Error(message);
}

function normalizePlatform(value) {
  const raw = String(value || '').toLowerCase();
  if (raw === 'mac' || raw === 'macos' || raw === 'darwin') return 'darwin';
  if (raw === 'win' || raw === 'windows' || raw === 'win32') return 'win32';
  return raw;
}

function normalizeArch(value) {
  const raw = String(value || '').toLowerCase();
  if (raw === 'x86_64' || raw === 'amd64') return 'x64';
  return raw;
}

function resolveTarget(platformValue, archValue) {
  const platform = normalizePlatform(platformValue);
  const arch = normalizeArch(archValue);
  if (!PLATFORMS.has(platform)) fail(`Unsupported native-addon platform: ${platformValue}`);
  if (!ARCHES.has(arch)) fail(`Unsupported native-addon architecture: ${archValue}`);
  const key = `${platform}-${arch}`;
  const sharpPackages = SHARP_PACKAGES[key];
  if (!sharpPackages) fail(`No sharp packages are defined for ${key}`);
  return { platform, arch, key, sharpPackages };
}

function existingChildren(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name);
}

function removeDirectory(directory) {
  fs.rmSync(directory, { recursive: true, force: true });
}

function sharpVersions() {
  const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'launcher', 'package.json'), 'utf8'));
  const optional = pkg.optionalDependencies || {};
  const versions = {};
  for (const name of Object.values(SHARP_PACKAGES).flat()) {
    const spec = optional[`@img/${name}`];
    if (spec) versions[name] = String(spec).replace(/^\^/, '');
  }
  return versions;
}

function ensureSharpPackages(nodeModules, target, versions, install) {
  const missing = target.sharpPackages.filter(name => (
    !fs.existsSync(path.join(nodeModules, '@img', name, 'package.json'))
  ));
  if (!missing.length) return [];
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'zyn-native-addons-'));
  try {
    const specs = missing.map((name) => {
      const version = versions[name];
      if (!version) fail(`launcher/package.json is missing optional @img/${name}`);
      return `@img/${name}@${version}`;
    });
    install(specs, staging);
    const imgRoot = path.join(nodeModules, '@img');
    fs.mkdirSync(imgRoot, { recursive: true });
    for (const name of missing) {
      const source = path.join(staging, 'node_modules', '@img', name);
      if (!fs.existsSync(path.join(source, 'package.json'))) {
        fail(`npm did not install @img/${name} for ${target.key}`);
      }
      removeDirectory(path.join(imgRoot, name));
      fs.cpSync(source, path.join(imgRoot, name), { recursive: true });
    }
  } finally {
    removeDirectory(staging);
  }
  return missing;
}

function defaultInstall(specs, staging) {
  const packed = execFileSync('npm', ['pack', '--pack-destination', staging, ...specs], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const archives = packed.split(/\r?\n/).map(line => line.trim()).filter(line => line.endsWith('.tgz'));
  if (archives.length !== specs.length) {
    fail(`npm pack did not return ${specs.length} packages`);
  }
  for (const archive of archives) {
    const match = path.basename(archive).match(/^img-(sharp(?:-libvips)?-[a-z0-9]+(?:-[a-z0-9]+)*)-\d/);
    if (!match) fail(`Unexpected sharp package archive: ${archive}`);
    const dest = path.join(staging, 'node_modules', '@img', match[1]);
    fs.mkdirSync(dest, { recursive: true });
    execFileSync('tar', ['-xzf', path.join(staging, archive), '-C', dest, '--strip-components', '1'], {
      stdio: 'pipe',
    });
  }
}

function pruneOnnx(nodeModules, target) {
  const root = path.join(nodeModules, 'onnxruntime-node', 'bin', 'napi-v3');
  const removed = [];
  for (const platform of existingChildren(root)) {
    const platformDir = path.join(root, platform);
    if (platform !== target.platform) {
      removeDirectory(platformDir);
      removed.push(`${platform}/*`);
      continue;
    }
    for (const arch of existingChildren(platformDir)) {
      if (arch === target.arch) continue;
      removeDirectory(path.join(platformDir, arch));
      removed.push(`${platform}/${arch}`);
    }
  }
  return removed;
}

function pruneSharp(nodeModules, target) {
  const root = path.join(nodeModules, '@img');
  const keep = new Set(target.sharpPackages);
  const removed = [];
  for (const name of existingChildren(root)) {
    if (!name.startsWith('sharp-') || keep.has(name)) continue;
    removeDirectory(path.join(root, name));
    removed.push(name);
  }
  return removed;
}

function assertRequired(nodeModules, target) {
  const binding = path.join(
    nodeModules,
    'onnxruntime-node',
    'bin',
    'napi-v3',
    target.platform,
    target.arch,
    'onnxruntime_binding.node',
  );
  if (!fs.existsSync(binding)) {
    fail(`onnxruntime_binding.node is missing for ${target.key}`);
  }
  for (const name of target.sharpPackages) {
    if (!fs.existsSync(path.join(nodeModules, '@img', name, 'package.json'))) {
      fail(`@img/${name} is missing after pruning ${target.key}`);
    }
  }
}

function pruneNativeAddons(nodeModules, platformValue, archValue, {
  versions = sharpVersions(),
  install = defaultInstall,
} = {}) {
  const target = resolveTarget(platformValue, archValue);
  const root = path.resolve(nodeModules);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    fail(`Native addon node_modules is missing: ${root}`);
  }
  const installed = ensureSharpPackages(root, target, versions, install);
  const removedOnnx = pruneOnnx(root, target);
  const removedSharp = pruneSharp(root, target);
  assertRequired(root, target);
  return {
    platform: target.platform,
    arch: target.arch,
    installed,
    removed: [...removedOnnx, ...removedSharp],
    onnx: path.join('onnxruntime-node', 'bin', 'napi-v3', target.platform, target.arch),
    sharp: target.sharpPackages,
  };
}

function parseArgs(argv) {
  if (argv.length !== 3) {
    fail('Usage: node scripts/prune-zyn-native-addons.cjs <node_modules> <darwin|win32> <arm64|x64>');
  }
  return { nodeModules: argv[0], platform: argv[1], arch: argv[2] };
}

if (require.main === module) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = pruneNativeAddons(args.nodeModules, args.platform, args.arch);
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } catch (error) {
    console.error(error.message || error);
    process.exitCode = 1;
  }
}

module.exports = {
  SHARP_PACKAGES,
  normalizeArch,
  normalizePlatform,
  pruneNativeAddons,
  resolveTarget,
};
