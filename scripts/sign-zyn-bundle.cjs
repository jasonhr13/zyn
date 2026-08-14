const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const bundle = path.resolve(process.argv[2] || '');
const macEntitlements = path.resolve(process.argv[3] || path.join(__dirname, '..', 'release', 'entitlements.mac.plist'));
const configuredIdentity = process.env.ZYN_SIGNING_IDENTITY || 'thwebco, LLC (GXWBXH5M77)';
const identity = configuredIdentity.startsWith('Developer ID Application:')
  ? configuredIdentity
  : `Developer ID Application: ${configuredIdentity}`;

if (!bundle || !fs.existsSync(bundle)) {
  console.error('Usage: node scripts/sign-zyn-bundle.cjs <bundle.app> [mac-entitlements.plist]');
  process.exit(1);
}
for (const entitlements of [macEntitlements]) {
  if (!fs.existsSync(entitlements)) {
    console.error(`Entitlements file not found: ${entitlements}`);
    process.exit(1);
  }
}

function visit(root, output = { files: [], bundles: [] }, top = root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      visit(full, output, top);
      if (full !== top && /\.(app|framework|xpc|bundle)$/i.test(entry.name)) output.bundles.push(full);
    }
    else if (entry.isFile()) {
      const stat = fs.statSync(full);
      if ((stat.mode & 0o111) || /\.(dylib|so|bundle)$/i.test(entry.name)) output.files.push(full);
    }
  }
  return output;
}

const found = visit(bundle);
const candidates = found.files
  .map((file) => {
    let description = '';
    try { description = execFileSync('/usr/bin/file', ['-b', file], { encoding: 'utf8' }); } catch {}
    return { file, description };
  })
  .filter((item) => /Mach-O/.test(item.description))
  .sort((a, b) => b.file.split(path.sep).length - a.file.split(path.sep).length);

console.log(`Signing ${candidates.length} Mach-O files in ${bundle}`);
for (const [index, item] of candidates.entries()) {
  const args = ['--force', '--timestamp', '--options', 'runtime', '--sign', identity];
  if (/executable/.test(item.description)) {
    args.push('--entitlements', macEntitlements);
  }
  args.push(item.file);
  execFileSync('/usr/bin/codesign', args, { stdio: 'inherit' });
  if ((index + 1) % 20 === 0 || index + 1 === candidates.length) {
    console.log(`  signed ${index + 1}/${candidates.length}`);
  }
}

const nestedBundles = found.bundles
  .sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);
for (const nested of nestedBundles) {
  const args = ['--force', '--timestamp', '--options', 'runtime', '--sign', identity];
  if (/\.(app|xpc)$/i.test(nested)) args.push('--entitlements', macEntitlements);
  args.push(nested);
  execFileSync('/usr/bin/codesign', args, { stdio: 'inherit' });
}
if (nestedBundles.length) console.log(`  sealed ${nestedBundles.length} nested bundles`);

execFileSync('/usr/bin/codesign', [
  '--force', '--timestamp', '--options', 'runtime', '--sign', identity,
  '--entitlements', macEntitlements, bundle,
], { stdio: 'inherit' });
execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', bundle], { stdio: 'inherit' });
console.log(`Signed Zyn bundle: ${bundle}`);
