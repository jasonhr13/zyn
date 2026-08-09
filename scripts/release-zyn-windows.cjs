#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const projectRoot = path.join(__dirname, '..');
const contract = require(path.join(projectRoot, 'config', 'runtime-contract.json'));
const version = contract.product.version;
const inputApp = path.join(projectRoot, 'dist', 'Zyn-win32-x64');
const workRoot = path.join(projectRoot, 'release', 'work', 'windows-x64');
const builderProject = path.join(workRoot, 'builder-project');
const outputRoot = path.join(projectRoot, 'release', 'dist', 'windows-x64');
const installerName = `Zyn-Setup-${version}-x64.exe`;
const builderCli = path.join(projectRoot, 'release-tools', 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');
const allowDirty = process.env.ZYN_ALLOW_DIRTY_RELEASE === '1';

function releaseNode() {
  if (process.env.ZYN_RELEASE_NODE) return path.resolve(process.env.ZYN_RELEASE_NODE);
  const candidates = [process.execPath];
  const versionsRoot = path.join(os.homedir(), '.nvm', 'versions', 'node');
  if (fs.existsSync(versionsRoot)) {
    for (const directory of fs.readdirSync(versionsRoot)) {
      candidates.push(path.join(versionsRoot, directory, 'bin', 'node'));
    }
  }
  const compatible = candidates.filter(candidate => {
    if (!fs.existsSync(candidate)) return false;
    try {
      const [major, minor] = execFileSync(candidate, ['-p', 'process.versions.node'], {
        encoding: 'utf8',
      }).trim().split('.').map(Number);
      return major > 20 || (major === 20 && minor >= 19);
    } catch {
      return false;
    }
  });
  if (!compatible.length) {
    throw new Error('electron-builder requires Node 20.19 or newer. Set ZYN_RELEASE_NODE to a compatible Node executable.');
  }
  compatible.sort((left, right) => {
    const version = executable => execFileSync(executable, ['-p', 'process.versions.node'], {
      encoding: 'utf8',
    }).trim().split('.').map(Number);
    const a = version(left);
    const b = version(right);
    return b[0] - a[0] || b[1] - a[1] || b[2] - a[2];
  });
  return compatible[0];
}

function run(command, args, options = {}) {
  console.log(`$ ${command} ${args.map(value => JSON.stringify(value)).join(' ')}`);
  execFileSync(command, args, { cwd: projectRoot, stdio: 'inherit', ...options });
}

if (!fs.existsSync(inputApp)) throw new Error(`Missing ${inputApp}; build Windows x64 first.`);
if (!fs.existsSync(builderCli)) throw new Error('Missing electron-builder. Run npm install in release-tools/.');
const receipt = JSON.parse(fs.readFileSync(path.join(inputApp, 'resources', 'zyn-build.json'), 'utf8'));
if (receipt.runtime?.delivery !== 'remote') throw new Error('Windows production releases must use the remote runtime.');
if (receipt.product?.version !== version) throw new Error(`Windows build is ${receipt.product?.version}; expected ${version}.`);
if (receipt.source?.dirty && !allowDirty) throw new Error('Windows build receipt is dirty. Commit the release source, then rebuild.');
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' }).trim();
if (receipt.source?.commit !== head && !allowDirty) throw new Error('Windows build does not match the current commit. Rebuild it.');
if ((fs.existsSync(outputRoot) || fs.existsSync(workRoot)) && process.env.ZYN_OVERWRITE_RELEASE !== '1') {
  throw new Error('Windows release staging already exists. Inspect it, then rerun with ZYN_OVERWRITE_RELEASE=1.');
}

fs.rmSync(workRoot, { recursive: true, force: true });
fs.rmSync(outputRoot, { recursive: true, force: true });
fs.mkdirSync(builderProject, { recursive: true });
fs.mkdirSync(outputRoot, { recursive: true });
fs.writeFileSync(path.join(builderProject, 'package.json'), `${JSON.stringify({
  name: 'zyn',
  productName: 'Zyn',
  version,
  description: 'Zyn desktop application',
  author: 'thwebco, LLC',
}, null, 2)}\n`);
const config = {
  appId: contract.product.bundleIdentifier,
  productName: 'Zyn',
  electronVersion: contract.product.electronVersion,
  copyright: `Copyright © ${new Date().getUTCFullYear()} thwebco, LLC`,
  directories: { output: outputRoot },
  artifactName: `Zyn-Setup-${version}-x64.\${ext}`,
  forceCodeSigning: false,
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: path.join(projectRoot, 'assets', 'brand', 'Zyn.ico'),
    signAndEditExecutable: false,
    publish: [{ provider: 'generic', url: 'https://updates.rcart.app/windows' }],
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    allowElevation: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    runAfterFinish: true,
    shortcutName: 'Zyn',
    uninstallDisplayName: 'Zyn',
  },
};
const configPath = path.join(builderProject, 'electron-builder.json');
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
run(releaseNode(), [
  builderCli,
  '--win',
  'nsis',
  '--x64',
  '--prepackaged',
  inputApp,
  '--config',
  configPath,
  '--publish',
  'never',
], {
  cwd: builderProject,
  env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
});

if (!fs.existsSync(path.join(outputRoot, installerName))) {
  throw new Error(`electron-builder did not produce ${installerName}.`);
}
run(process.execPath, [path.join(__dirname, 'verify-zyn-windows-release.cjs')]);
console.log(`Zyn ${version} Windows x64 is unsigned and ready to upload from ${outputRoot}`);
