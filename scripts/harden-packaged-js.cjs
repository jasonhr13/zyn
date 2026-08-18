#!/usr/bin/env node
'use strict';

// Production pack-time hardening for first-party JavaScript. This is a delay, not DRM:
// asar extract, bytecode decompilers, and determined reversing still work. Do not ship
// source maps, and never treat this as a substitute for keeping secrets off the client.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const projectRoot = path.join(__dirname, '..');
const SKIP_DIR = /(^|[/\\])node_modules([/\\]|$)|(^|[/\\])build([/\\]|$)/;
const PINNED_FARMER_FILES = new Set(Object.keys(
  JSON.parse(fs.readFileSync(path.join(projectRoot, 'config', 'native-farmer-upstream.json'), 'utf8')).files || {},
));
const SKIP_FILES = new Set([
  'feature-flags.js',
  'package.json',
  'package-lock.json',
  ...PINNED_FARMER_FILES,
]);
const BYTECODE_FILES = new Set([
  'target-engine.js',
  'native-engine-contract.js',
  'native-hyper-broker.js',
  'license-authority.js',
  'license-client.js',
  'license-observer.js',
  'target-group-launch.js',
  'runtime-manager.js',
  'pokemon-queue-events.js',
]);

function parseArgs(argv) {
  const roots = [];
  let electron = '';
  let bytecode = process.env.ZYN_JS_BYTECODE !== '0';
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--electron') {
      electron = argv[index + 1] || '';
      index += 1;
      continue;
    }
    if (arg === '--no-bytecode') {
      bytecode = false;
      continue;
    }
    roots.push(path.resolve(arg));
  }
  return { roots, electron, bytecode };
}

function walk(root, files = []) {
  if (!fs.existsSync(root)) return files;
  const stats = fs.statSync(root);
  if (stats.isFile()) {
    files.push(root);
    return files;
  }
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIR.test(full)) continue;
      walk(full, files);
      continue;
    }
    if (entry.isFile()) files.push(full);
  }
  return files;
}

function loadObfuscator() {
  const candidates = [
    path.join(projectRoot, 'frontend', 'node_modules', 'javascript-obfuscator'),
    'javascript-obfuscator',
  ];
  for (const candidate of candidates) {
    try { return require(candidate); } catch {}
  }
  throw new Error('javascript-obfuscator is missing. Run npm install in frontend/.');
}

function obfuscateFile(file, obfuscator) {
  const source = fs.readFileSync(file, 'utf8');
  const ext = path.extname(file);
  const result = obfuscator.obfuscate(source, {
    compact: true,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.35,
    deadCodeInjection: false,
    identifierNamesGenerator: 'hexadecimal',
    renameGlobals: false,
    selfDefending: false,
    simplify: true,
    splitStrings: true,
    splitStringsChunkLength: 6,
    stringArray: true,
    stringArrayCallsTransform: true,
    stringArrayEncoding: ['base64'],
    stringArrayThreshold: 0.75,
    target: 'node',
    unicodeEscapeSequence: false,
    sourceMap: false,
    inputFileName: path.basename(file),
    sourceType: ext === '.mjs' ? 'module' : 'script',
  });
  const next = result.getObfuscatedCode();
  if (!next || next.length < 20) throw new Error(`obfuscation produced empty output for ${file}`);
  fs.writeFileSync(file, `${next}\n`);
}

function compileBytecode(file, electron) {
  const bytenode = path.join(projectRoot, 'frontend', 'node_modules', 'bytenode');
  const loader = `'use strict';\nrequire('bytenode');\nmodule.exports = require(${JSON.stringify(`./${path.basename(file, path.extname(file))}.jsc`)});\n`;
  execFileSync(electron, ['-e', `
    process.chdir(${JSON.stringify(path.dirname(file))});
    require(${JSON.stringify(bytenode)}).compileFile(${JSON.stringify(file)});
  `], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'inherit',
  });
  const compiled = file.replace(/\.js$/i, '.jsc');
  if (!fs.existsSync(compiled)) throw new Error(`bytenode did not write ${compiled}`);
  fs.writeFileSync(file, loader);
}

function shouldObfuscate(file) {
  if (SKIP_DIR.test(file)) return false;
  if (SKIP_FILES.has(path.basename(file))) return false;
  return /\.(js|cjs|mjs)$/i.test(file);
}

function shouldBytecode(file) {
  return BYTECODE_FILES.has(path.basename(file)) && /\.js$/i.test(file);
}

function main() {
  const { roots, electron, bytecode } = parseArgs(process.argv);
  if (!roots.length) {
    console.error('Usage: node scripts/harden-packaged-js.cjs <dir> [--electron <Electron>] [--no-bytecode]');
    process.exit(2);
  }
  const obfuscator = loadObfuscator();
  let obfuscated = 0;
  let compiled = 0;
  for (const root of roots) {
    for (const file of walk(root)) {
      if (!shouldObfuscate(file)) continue;
      obfuscateFile(file, obfuscator);
      obfuscated += 1;
      if (bytecode && electron && shouldBytecode(file)) {
        compileBytecode(file, electron);
        compiled += 1;
      }
    }
  }
  console.log(`Hardened ${obfuscated} JavaScript file${obfuscated === 1 ? '' : 's'}`
    + (compiled ? `, compiled ${compiled} to V8 bytecode` : '')
    + '.');
}

if (require.main === module) main();

module.exports = { BYTECODE_FILES, shouldObfuscate, shouldBytecode };
