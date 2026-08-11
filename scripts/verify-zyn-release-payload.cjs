#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

function payloadTree(root, options = {}) {
  const { materializeSymlinks = false } = options;
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory()) throw new Error(`Release payload root is not a directory: ${root}`);
  const resolvedRoot = fs.realpathSync(root);

  const entries = [];
  function visit(directory, relativeDirectory = '') {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name);
      const relative = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const item = fs.lstatSync(file);
      if (item.isDirectory()) {
        entries.push({ path: relative, type: 'directory' });
        visit(file, relative);
      } else if (item.isSymbolicLink()) {
        if (!materializeSymlinks) {
          entries.push({ path: relative, type: 'symlink', target: fs.readlinkSync(file) });
          continue;
        }
        const resolvedTarget = fs.realpathSync(file);
        const relativeTarget = path.relative(resolvedRoot, resolvedTarget);
        if (relativeTarget === '..' || relativeTarget.startsWith(`..${path.sep}`) || path.isAbsolute(relativeTarget)) {
          throw new Error(`Release payload symlink escapes its app root: ${file}`);
        }
        const target = fs.statSync(file);
        if (!target.isFile()) throw new Error(`Release payload symlink does not target a file: ${file}`);
        entries.push({
          path: relative,
          type: 'file',
          bytes: target.size,
          executable: Boolean(target.mode & 0o111),
          sha256: sha256File(file),
        });
      } else if (item.isFile()) {
        entries.push({
          path: relative,
          type: 'file',
          bytes: item.size,
          executable: Boolean(item.mode & 0o111),
          sha256: sha256File(file),
        });
      } else {
        throw new Error(`Unsupported file type in release payload: ${file}`);
      }
    }
  }
  visit(root);
  return entries;
}

function payloadTreeDigest(entries) {
  const hash = crypto.createHash('sha256');
  for (const entry of entries) hash.update(`${JSON.stringify(entry)}\n`);
  return hash.digest('hex');
}

function comparePayloadTrees(expectedRoot, actualRoot, label, options = {}) {
  const expected = payloadTree(expectedRoot, options);
  const actual = payloadTree(actualRoot, options);
  const expectedByPath = new Map(expected.map((entry) => [entry.path, entry]));
  const actualByPath = new Map(actual.map((entry) => [entry.path, entry]));
  const paths = [...new Set([...expectedByPath.keys(), ...actualByPath.keys()])].sort();

  for (const relative of paths) {
    const wanted = expectedByPath.get(relative);
    const found = actualByPath.get(relative);
    if (!wanted) throw new Error(`${label} contains an unexpected payload entry: ${relative}`);
    if (!found) throw new Error(`${label} is missing payload entry: ${relative}`);
    if (JSON.stringify(wanted) !== JSON.stringify(found)) {
      throw new Error(`${label} payload differs from the verified app at ${relative}`);
    }
  }

  return { entries: actual.length, sha256: payloadTreeDigest(actual) };
}

function run(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    const detail = String(error.stderr || error.stdout || error.message || error).trim();
    throw new Error(`${path.basename(command)} failed while inspecting a release payload${detail ? `: ${detail}` : ''}`);
  }
}

function executableFromPath(name) {
  try {
    const result = execFileSync('/usr/bin/which', [name], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return result && fs.existsSync(result) ? result : '';
  } catch {
    return '';
  }
}

function findExecutable(root, names, depth = 0) {
  if (!root || !fs.existsSync(root) || depth > 5) return '';
  for (const name of fs.readdirSync(root).sort()) {
    const candidate = path.join(root, name);
    const stat = fs.lstatSync(candidate);
    if (stat.isFile() && names.has(name) && (stat.mode & 0o111)) return candidate;
    if (stat.isDirectory()) {
      const nested = findExecutable(candidate, names, depth + 1);
      if (nested) return nested;
    }
  }
  return '';
}

function resolveSevenZip() {
  const explicit = process.env.ZYN_7ZIP || process.env.ELECTRON_BUILDER_7ZIP_PATH;
  if (explicit) {
    const resolved = path.resolve(explicit);
    if (!fs.existsSync(resolved)) throw new Error(`Configured 7-Zip executable does not exist: ${resolved}`);
    return resolved;
  }

  for (const candidate of [
    executableFromPath('7zz'),
    executableFromPath('7z'),
    executableFromPath('7za'),
    '/opt/homebrew/bin/7zz',
    '/usr/local/bin/7zz',
  ]) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }

  const cacheRoots = process.platform === 'darwin'
    ? [path.join(os.homedir(), 'Library', 'Caches', 'electron-builder')]
    : [path.join(os.homedir(), '.cache', 'electron-builder')];
  for (const cacheRoot of cacheRoots) {
    const cached = findExecutable(cacheRoot, new Set(process.platform === 'win32'
      ? ['7za.exe', '7zz.exe', '7z.exe']
      : ['7za', '7zz', '7z']));
    if (cached) return cached;
  }

  throw new Error('7-Zip is required to inspect the NSIS payload. Install 7zz or set ZYN_7ZIP.');
}

function verifyMacBundleIdentity(app, label) {
  const plist = path.join(app, 'Contents', 'Info.plist');
  if (!fs.existsSync(plist)) throw new Error(`${label} is missing Contents/Info.plist`);
  let identity;
  try {
    identity = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist]));
  } catch (error) {
    throw new Error(`${label} Info.plist could not be read: ${error.message}`);
  }
  for (const key of ['CFBundleName', 'CFBundleDisplayName', 'CFBundleExecutable']) {
    if (identity[key] !== 'Zyn') throw new Error(`${label} ${key} must be exactly Zyn`);
  }
  const serialized = JSON.stringify(identity);
  for (const [description, pattern] of [
    ['Polar product identity', /\bPolar(?:[\s_-]*AIO)?\b/i],
    ['Hope product identity', /\bHope\b/i],
    ['retired rCart product identity', /\brCart\b/i],
  ]) {
    if (pattern.test(serialized)) throw new Error(`${label} Info.plist contains ${description}`);
  }
  return {
    CFBundleName: identity.CFBundleName,
    CFBundleDisplayName: identity.CFBundleDisplayName,
    CFBundleExecutable: identity.CFBundleExecutable,
  };
}

function verifyMacReleasePayload({ expectedApp, zip, dmg, verifyExtractedApp }) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'zyn-macos-payload-'));
  const zipRoot = path.join(temporary, 'zip');
  const mountPoint = path.join(temporary, 'dmg');
  let mounted = false;
  try {
    fs.mkdirSync(zipRoot);
    run('/usr/bin/ditto', ['-x', '-k', zip, zipRoot]);
    const zipApp = path.join(zipRoot, 'Zyn.app');
    const zipIdentity = verifyMacBundleIdentity(zipApp, 'macOS ZIP Zyn.app');
    const zipResult = comparePayloadTrees(expectedApp, zipApp, 'macOS ZIP');
    if (verifyExtractedApp) verifyExtractedApp(zipApp, 'ZIP');

    fs.mkdirSync(mountPoint);
    run('/usr/bin/hdiutil', [
      'attach', '-readonly', '-nobrowse', '-owners', 'on', '-mountpoint', mountPoint, dmg,
    ]);
    mounted = true;
    const dmgApp = path.join(mountPoint, 'Zyn.app');
    const dmgIdentity = verifyMacBundleIdentity(dmgApp, 'macOS DMG Zyn.app');
    const dmgResult = comparePayloadTrees(expectedApp, dmgApp, 'macOS DMG');
    if (verifyExtractedApp) verifyExtractedApp(dmgApp, 'DMG');
    return {
      zip: { ...zipResult, identity: zipIdentity },
      dmg: { ...dmgResult, identity: dmgIdentity },
    };
  } finally {
    let detached = !mounted;
    if (mounted) {
      try {
        run('/usr/bin/hdiutil', ['detach', mountPoint]);
        detached = true;
      } catch (error) {
        console.error(error.message);
      }
    }
    if (detached) fs.rmSync(temporary, { recursive: true, force: true });
    else console.error(`DMG mount cleanup failed; retained temporary mount point at ${mountPoint}`);
  }
}

function verifyWindowsReleasePayload({ expectedApp, installer, verifyExtractedApp }) {
  const sevenZip = resolveSevenZip();
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'zyn-windows-payload-'));
  const outer = path.join(temporary, 'installer');
  const app = path.join(temporary, 'app');
  try {
    fs.mkdirSync(outer);
    fs.mkdirSync(app);
    const listing = run(sevenZip, ['l', '-slt', installer]);
    if (!/^Type = Nsis$/m.test(listing)) throw new Error('Windows installer is not an NSIS archive');
    if (!/^Path = \$R0[\\/]Uninstall Zyn\.exe$/m.test(listing)) {
      throw new Error('NSIS installer does not advertise the Zyn uninstaller');
    }
    if (/\bPolar(?:[\s_-]*AIO)?\b|\bHope\b|\brCart\b/i.test(listing)) {
      throw new Error('NSIS installer file metadata contains a legacy product identity');
    }
    run(sevenZip, ['x', '-y', `-o${outer}`, installer]);
    const appArchive = path.join(outer, '$PLUGINSDIR', 'app-64.7z');
    if (!fs.existsSync(appArchive)) {
      throw new Error('NSIS installer does not contain the expected $PLUGINSDIR/app-64.7z payload');
    }
    run(sevenZip, ['x', '-y', `-o${app}`, appArchive]);
    // electron-builder deliberately materializes file symlinks in its Windows 7z payload.
    const result = comparePayloadTrees(expectedApp, app, 'Windows NSIS installer', { materializeSymlinks: true });
    if (verifyExtractedApp) verifyExtractedApp(app);
    return result;
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

module.exports = {
  comparePayloadTrees,
  payloadTree,
  payloadTreeDigest,
  resolveSevenZip,
  verifyMacBundleIdentity,
  verifyMacReleasePayload,
  verifyWindowsReleasePayload,
};
