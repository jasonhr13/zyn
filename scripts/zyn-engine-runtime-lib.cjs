'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const release = require(path.join(projectRoot, 'config', 'engine-runtime.json'));

const PLATFORM = Object.freeze({
  arm64: {
    source: 'native-backend/darwin-arm64/backend',
    suffix: 'macos-arm64.tar.xz',
    format: 'tar.xz',
    entry: 'engine/Zyn Engine.app/Contents/MacOS/backend',
    verify: 'engine/Zyn Engine.app',
  },
  x64: {
    source: 'native-backend/darwin-x64/backend',
    suffix: 'macos-x64.tar.xz',
    format: 'tar.xz',
    entry: 'engine/Zyn Engine.app/Contents/MacOS/backend',
    verify: 'engine/Zyn Engine.app',
  },
  'windows-x64': {
    source: 'native-backend/windows-x64/backend.exe',
    suffix: 'windows-x64.tar.gz',
    format: 'tar.gz',
    entry: 'engine/backend.exe',
    verify: 'engine/backend.exe',
  },
});

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function engineRuntime(arch) {
  const platform = PLATFORM[arch];
  if (!platform) throw new Error(`Unsupported engine runtime architecture: ${arch}`);
  if (release.schemaVersion !== 1 || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(String(release.version))) {
    throw new Error('config/engine-runtime.json has an invalid version.');
  }
  if (!Number.isSafeInteger(release.protocol) || release.protocol < 1) {
    throw new Error('config/engine-runtime.json has an invalid protocol.');
  }
  const source = path.join(projectRoot, platform.source);
  if (!fs.existsSync(source)) throw new Error(`Missing native engine: ${source}`);
  const sourceSha256 = sha256(source);
  // The content suffix makes published URLs immutable even if somebody rebuilds without bumping
  // the human release number. The signed manifest still presents both values for diagnosis.
  const version = `${release.version}-${sourceSha256.slice(0, 12)}`;
  const archive = `zyn-engine-${version}-${platform.suffix}`;
  return {
    ...platform,
    arch,
    source,
    sourceSha256,
    version,
    archive,
    protocol: release.protocol,
  };
}

module.exports = { PLATFORM, engineRuntime, projectRoot, release, sha256 };
