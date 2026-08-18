#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const asar = require('../frontend/node_modules/@electron/asar');
const {
  ALLOWED_INTERNAL_POLAR_MARKERS,
  LEGACY_MARKERS,
  REQUIRED_MARKERS,
  verifyNativeGoBuildMetadataOutput,
  verifyNativeWebhookBrand,
  verifyNativeWebhookBrandBuffer,
} = require('./verify-zyn-native-webhook-brand.cjs');
const {
  assertBackupIdentity,
  assertExplicitZynWebhookIdentity,
  assertNoLegacyBrand,
  assertPackageIdentity,
  assertRendererIdentity,
  assertTargetHarvesterIdentity,
  verifyZynPackagedBrand,
} = require('./verify-zyn-packaged-brand-boundary.cjs');

const project = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'zyn-brand-verifier-'));

function write(root, relative, source) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
}

function expectFailure(action, pattern, label) {
  assert.throws(action, error => pattern.test(String(error && error.message)), label);
}

function packageJson(description = 'Zyn Checkout Automation') {
  return `${JSON.stringify({
    name: 'zyn',
    productName: 'Zyn',
    description,
    version: '0.0.0-test',
  }, null, 2)}\n`;
}

const zynWebhookSource = `
const endpoint = 'https://discord.com/api/webhooks/fixture';
const payload = {
  username: 'Zyn',
  avatar_url: 'https://zynbot.app/zyn-icon.png',
  embeds: [{ footer: { text: 'Zyn', icon_url: 'https://zynbot.app/zyn-icon.png' } }],
};
`;

const targetHarvesterSource = `<!doctype html>
<html><head><title>Zyn</title></head><body>
  <div class="harvest-cover"><div class="zyn-mark">Zyn</div></div>
</body></html>`;

async function buildSyntheticZynEngine() {
  const moduleRoot = path.join(temporary, 'synthetic-engine-source');
  write(moduleRoot, 'go.mod', 'module zynbot.app/engine\n\ngo 1.23\n');
  write(moduleRoot, 'cmd/zyn-engine/main.go', `package main

import "fmt"

func main() {
	fmt.Println("https://zynbot.app/zyn-icon.png zynbot.app/engine ZYN_SHAPE_TOKEN x-zyn-token Zyn-Task-Log-v1 zyn-engine monitor-bandwidth tls-client-wire")
}
`);
  const engine = path.join(temporary, 'synthetic-zyn-engine');
  execFileSync('go', ['build', '-trimpath', '-o', engine, './cmd/zyn-engine'], {
    cwd: moduleRoot,
    env: { ...process.env, GOCACHE: path.join(temporary, 'go-build-cache') },
    stdio: 'pipe',
  });
  verifyNativeWebhookBrand(engine);
  return engine;
}

async function createPackagedFixture(name, engine, options = {}) {
  const root = path.join(temporary, name);
  const resources = path.join(root, 'resources');
  const sourceRoot = path.join(root, 'asar-source');
  const asarFiles = {
    'package.json': packageJson(),
    'build/index.html': '<!doctype html><title>Zyn</title><main>Zyn</main>',
    'build/static/js/main.js': "document.body.dataset.product = 'Zyn';\n",
    'build/zyn-icon.png': fs.readFileSync(path.join(project, 'frontend', 'public', 'zyn-icon.png')),
    'public/electron.js': `
const stamp = 'test';
const exportDialog = { title: 'Export Zyn data', defaultPath: \`zyn-backup-\${stamp}.json\` };
const importDialog = { title: 'Import Zyn data' };
`,
    'public/helpers/data-manager.js': `
const bundle = { app: 'zyn' };
if (!bundle) throw new Error('Not a Zyn export file.');
`,
    'public/helpers/checkout-reporter.js': zynWebhookSource,
    'public/nested/clean.js': "module.exports = 'Zyn';\n",
    // These are deliberately outside the first-party boundary and must not create false positives.
    'public/vendor/legacy.js': "module.exports = 'Polar AIO';\n",
    'build/node_modules/example/legacy.js': "module.exports = 'Hope';\n",
    ...(options.asarFiles || {}),
  };
  if (options.embeddedBackend) asarFiles['backend/backend'] = 'obsolete engine';
  for (const [relative, source] of Object.entries(asarFiles)) write(sourceRoot, relative, source);
  fs.mkdirSync(resources, { recursive: true });
  await asar.createPackage(sourceRoot, path.join(resources, 'app-original.asar'));

  const botFiles = {
    'pbandai-buyer.cjs': zynWebhookSource,
    'secret-lair-browserless.mjs': zynWebhookSource,
    'shared.mjs': zynWebhookSource,
    'target-atc-v2.html': targetHarvesterSource,
    'nested/clean.mjs': "export const product = 'Zyn';\n",
    'node_modules/example/legacy.js': "module.exports = 'Polar AIO';\n",
    'vendor/example/legacy.html': '<title>Hope</title>',
    ...(options.botFiles || {}),
  };
  for (const [relative, source] of Object.entries(botFiles)) write(path.join(resources, 'bot'), relative, source);
  write(path.join(resources, 'app'), 'bootstrap.js', "module.exports = 'Zyn';\n");
  write(path.join(resources, 'app'), 'node_modules/example/legacy.js', "module.exports = 'Polar AIO';\n");
  write(path.join(resources, 'app'), 'vendor/example/legacy.js', "module.exports = 'Hope';\n");
  fs.mkdirSync(path.join(resources, 'engine'), { recursive: true });
  fs.copyFileSync(engine, path.join(resources, 'engine', 'backend'));
  return { root, resources, engineFile: path.join(resources, 'engine', 'backend') };
}

async function main() {
  const requiredValues = REQUIRED_MARKERS.map(([, marker]) => marker);
  const cleanNative = Buffer.from(requiredValues.join('\u0000'));
  verifyNativeWebhookBrandBuffer(cleanNative, 'clean native fixture');
  verifyNativeWebhookBrandBuffer(
    Buffer.concat([cleanNative, ...ALLOWED_INTERNAL_POLAR_MARKERS.map(marker => Buffer.from(`\u0000${marker}`))]),
    'allowlisted internal endpoints fixture',
  );
  expectFailure(
    () => verifyNativeWebhookBrandBuffer(Buffer.concat([cleanNative, Buffer.from('\u0000Polar Checkout')]), 'bare Polar fixture'),
    /unexpected Polar identity/,
    'native verifier accepted a non-allowlisted Polar identity',
  );
  for (const [description, marker] of LEGACY_MARKERS) {
    expectFailure(
      () => verifyNativeWebhookBrandBuffer(Buffer.concat([cleanNative, Buffer.from(`\u0000${marker}`)]), description),
      /contains/,
      `native verifier accepted ${description}`,
    );
  }
  expectFailure(
    () => verifyNativeWebhookBrandBuffer(Buffer.concat([cleanNative, Buffer.from('\u0000rCart\u0000')]), 'rCart fixture'),
    /rCart product identity/,
    'native verifier accepted the retired rCart product identity',
  );
  verifyNativeWebhookBrandBuffer(
    Buffer.concat([cleanNative, Buffer.from('\u0000ClearCart\u0000')]),
    'Walmart ClearCart method fixture',
  );
  for (let index = 0; index < REQUIRED_MARKERS.length; index += 1) {
    const [description] = REQUIRED_MARKERS[index];
    const missing = Buffer.from(requiredValues.filter((_, candidate) => candidate !== index).join('\u0000'));
    expectFailure(
      () => verifyNativeWebhookBrandBuffer(missing, description),
      /does not contain/,
      `native verifier accepted a binary without ${description}`,
    );
  }

  const cleanMetadata = `/tmp/backend: go1.test
\tpath\tzynbot.app/engine/cmd/zyn-engine
\tmod\tzynbot.app/engine\t(devel)\n`;
  verifyNativeWebhookBrandBuffer(Buffer.from('garbled-engine-fixture-without-protocol-strings'), 'garbled native fixture');
  verifyNativeGoBuildMetadataOutput(cleanMetadata, 'clean metadata fixture');
  expectFailure(
    () => verifyNativeGoBuildMetadataOutput(cleanMetadata.replaceAll('zynbot.app/engine', 'github.com/PolarAIO/Polar-AIO/backend'), 'legacy metadata fixture'),
    /not rooted|module|legacy/,
    'metadata verifier accepted a legacy module',
  );

  const legacyTextSamples = [
    'Polar',
    'Polar AIO',
    'PolarAIO',
    'Polar-AIO',
    'Polar_AIO',
    'github.com/PolarAIO/Polar-AIO',
    'Hope',
    'HOPE_SHAPE_TOKEN',
    'x-hope-token',
    'hope-shape-broker',
    'hope://settings',
    'Secret Lair Bot',
    'Secret Lair Checkout Bot',
    'secret-lair-bot',
    'https://media.discordapp.net/attachments/1443088896396361731/1487029472778518558/Adobe_Express_-_file.png',
    'rCart',
  ];
  assertNoLegacyBrand('Zyn Checkout Automation', 'clean text fixture');
  for (const sample of legacyTextSamples) {
    expectFailure(
      () => assertNoLegacyBrand(`fixture ${sample} fixture`, 'legacy text fixture'),
      /contains/,
      `text verifier accepted ${sample}`,
    );
  }

  assertExplicitZynWebhookIdentity(zynWebhookSource, 'clean webhook fixture');
  for (const property of ['username', 'avatar_url', 'footer']) {
    const broken = property === 'footer'
      ? zynWebhookSource.replace("text: 'Zyn'", "text: 'Checkout'")
      : zynWebhookSource.replace(new RegExp(`${property}:\\s*'[^']+'`), `${property}: 'Checkout'`);
    expectFailure(
      () => assertExplicitZynWebhookIdentity(broken, `missing ${property}`),
      /does not explicitly set/,
      `webhook verifier accepted a missing ${property}`,
    );
  }
  assertPackageIdentity(packageJson(), 'clean package fixture');
  expectFailure(
    () => assertPackageIdentity(packageJson('Secret Lair Checkout Bot'), 'legacy package fixture'),
    /description must be Zyn Checkout Automation/,
    'package verifier accepted a legacy description',
  );
  assertBackupIdentity(
    "const a={title:'Export Zyn data',defaultPath:`zyn-backup-${stamp}.json`}; const b={title:'Import Zyn data'};",
    "const bundle={app:'zyn'}; throw new Error('Not a Zyn export file.');",
    'clean backup fixture',
  );
  expectFailure(
    () => assertBackupIdentity(
      "const a={title:'Export data',defaultPath:`backup-${stamp}.json`}; const b={title:'Import data'};",
      "const bundle={app:'other'}; throw new Error('Not an export file.');",
      'legacy backup fixture',
    ),
    /Zyn/,
    'backup verifier accepted a non-Zyn flow',
  );
  assertTargetHarvesterIdentity(targetHarvesterSource, 'clean harvester fixture');
  expectFailure(
    () => assertTargetHarvesterIdentity(targetHarvesterSource.replace('<title>Zyn</title>', '<title>Target</title>'), 'legacy harvester fixture'),
    /title must be Zyn/,
    'harvester verifier accepted a non-Zyn title',
  );
  const cleanRendererFixture = [
    { relative: 'build/index.html', source: '<!doctype html><title>Zyn</title>' },
    { relative: 'build/static/js/main.js', source: "document.body.dataset.product = 'Zyn';" },
  ];
  assertRendererIdentity(cleanRendererFixture, 'clean renderer fixture');
  expectFailure(
    () => assertRendererIdentity(
      cleanRendererFixture.map(file => file.relative === 'build/index.html'
        ? { ...file, source: file.source.replace('Zyn', 'Checkout') }
        : file),
      'unbranded renderer title fixture',
    ),
    /title must be Zyn/,
    'renderer verifier accepted a non-Zyn document title',
  );
  expectFailure(
    () => assertRendererIdentity(
      cleanRendererFixture.map(file => file.relative.endsWith('.js')
        ? { ...file, source: "document.body.dataset.product = 'Checkout';" }
        : file),
      'unbranded renderer bundle fixture',
    ),
    /renderer JavaScript does not visibly identify Zyn/,
    'renderer verifier accepted an unbranded renderer bundle',
  );

  const targetSource = fs.readFileSync(path.join(project, 'native-farmer', 'target-atc-v2.html'), 'utf8');
  assertNoLegacyBrand(targetSource, 'native-farmer/target-atc-v2.html');
  assertTargetHarvesterIdentity(targetSource, 'native-farmer/target-atc-v2.html');
  const botPatcher = fs.readFileSync(path.join(project, 'scripts', 'patch-zyn-bot-webhook-brand.cjs'), 'utf8');
  for (const sender of ['pbandai-buyer.cjs', 'round1-register.mjs', 'secret-lair-browserless.mjs', 'shared.mjs']) {
    assert.match(botPatcher, new RegExp(sender.replaceAll('.', '\\.')), `bot patcher does not cover ${sender}`);
  }
  for (const buildScript of ['scripts/build-zyn.sh', 'scripts/build-zyn-windows.sh']) {
    const source = fs.readFileSync(path.join(project, buildScript), 'utf8');
    assert.match(source, /runtime-app/, `${buildScript} does not stage the tracked runtime source`);
    assert.doesNotMatch(source, /extracted\/asar/, `${buildScript} still stages the recovered runtime input`);
    assert.match(source, /pkg\.description = "Zyn Checkout Automation"/, `${buildScript} does not set the Zyn package description`);
  }
  assert.equal(fs.existsSync(path.join(project, 'runtime-app', 'backend')), false,
    'tracked runtime source contains an obsolete embedded backend');
  const macBuild = fs.readFileSync(path.join(project, 'scripts', 'build-zyn.sh'), 'utf8');
  const macContractVerifier = fs.readFileSync(path.join(project, 'scripts', 'verify-runtime-contract.js'), 'utf8');
  assert.match(macBuild, /verify-runtime-contract\.js/, 'mac build does not invoke the runtime-contract verifier');
  assert.match(macContractVerifier, /require\('\.\/verify-zyn-packaged-brand-boundary\.cjs'\)/,
    'mac runtime-contract verifier does not import the shared brand boundary');
  assert.match(macContractVerifier, /verifyZynPackagedBrand\(\{/,
    'mac runtime-contract verifier does not run the shared brand boundary');

  const macRelease = fs.readFileSync(path.join(project, 'scripts', 'release-zyn-macos.cjs'), 'utf8');
  const macReleaseVerifier = fs.readFileSync(path.join(project, 'scripts', 'verify-zyn-macos-release.cjs'), 'utf8');
  const macUpload = fs.readFileSync(path.join(project, 'scripts', 'upload-zyn-macos-release.cjs'), 'utf8');
  assert.match(macRelease, /'verify-runtime-contract\.js'\), workApp\][\s\S]*'sign-zyn-bundle\.cjs'\), workApp\]/,
    'mac release does not verify the staged app before signing');
  assert.match(macReleaseVerifier, /'zyn-packaged-brand-smoke-test\.js'\), workApp\]/,
    'mac release verifier does not rerun the shared packaged-brand boundary');
  assert.match(macReleaseVerifier, /verifyMacReleasePayload\(\{/,
    'mac release verifier does not inspect the actual ZIP and DMG payloads');
  assert.match(macReleaseVerifier, /verifyExtractedApp\(extractedApp\)[\s\S]*zyn-packaged-brand-smoke-test\.js/,
    'mac release verifier does not scan the extracted ZIP and DMG apps');
  assert.match(macUpload, /'verify-zyn-macos-release\.cjs'\), arch\]/,
    'mac upload does not invoke the protected release verifier');

  const windowsBuild = fs.readFileSync(path.join(project, 'scripts', 'build-zyn-windows.sh'), 'utf8');
  const windowsBuildVerifier = fs.readFileSync(path.join(project, 'scripts', 'verify-zyn-windows-build.cjs'), 'utf8');
  const windowsReleaseVerifier = fs.readFileSync(path.join(project, 'scripts', 'verify-zyn-windows-release.cjs'), 'utf8');
  const windowsUpload = fs.readFileSync(path.join(project, 'scripts', 'upload-zyn-windows-release.cjs'), 'utf8');
  assert.match(windowsBuild, /verify-zyn-windows-build\.cjs/, 'Windows build does not invoke its verifier');
  assert.match(windowsBuildVerifier, /require\('\.\/verify-zyn-packaged-brand-boundary\.cjs'\)/,
    'Windows build verifier does not import the shared brand boundary');
  assert.match(windowsBuildVerifier, /verifyZynPackagedBrand\(\{/,
    'Windows build verifier does not run the shared brand boundary');
  assert.match(windowsReleaseVerifier, /'verify-zyn-windows-build\.cjs'\), appPath\]/,
    'Windows release verifier does not rerun the protected build verifier');
  assert.match(windowsReleaseVerifier, /verifyWindowsReleasePayload\(\{/,
    'Windows release verifier does not inspect the actual NSIS payload');
  assert.match(windowsReleaseVerifier, /verifyExtractedApp\(extractedApp\)[\s\S]*verify-zyn-windows-build\.cjs/,
    'Windows release verifier does not scan the extracted NSIS app');
  assert.match(windowsUpload, /'verify-zyn-windows-release\.cjs'\)\]/,
    'Windows upload does not invoke the protected release verifier');

  const engine = await buildSyntheticZynEngine();
  const cleanFixture = await createPackagedFixture('clean-package', engine);
  const result = verifyZynPackagedBrand({ ...cleanFixture, label: 'clean package fixture' });
  assert.deepEqual(result.botWebhookSenders, [
    'pbandai-buyer.cjs',
    'secret-lair-browserless.mjs',
    'shared.mjs',
  ]);

  const legacyAsarFixture = await createPackagedFixture('legacy-asar-package', engine, {
    asarFiles: { 'public/nested/legacy.js': "module.exports = 'PolarAIO';\n" },
  });
  expectFailure(
    () => verifyZynPackagedBrand({ ...legacyAsarFixture, label: 'legacy ASAR fixture' }),
    /ASAR\/public\/nested\/legacy\.js contains Polar/,
    'packaged verifier did not scan nested first-party ASAR text',
  );

  const legacySourceMapFixture = await createPackagedFixture('legacy-source-map-package', engine, {
    asarFiles: {
      'build/static/js/main.js.map': JSON.stringify({
        version: 3,
        sources: ['legacy.js'],
        sourcesContent: ["document.title = 'Polar AIO';"],
      }),
    },
  });
  expectFailure(
    () => verifyZynPackagedBrand({ ...legacySourceMapFixture, label: 'legacy source-map fixture' }),
    /ASAR\/build\/static\/js\/main\.js\.map contains Polar/,
    'packaged verifier did not scan renderer source maps',
  );

  const legacyRendererIconFixture = await createPackagedFixture('legacy-renderer-icon-package', engine, {
    asarFiles: { 'build/zyn-icon.png': Buffer.from('not the reviewed Zyn icon') },
  });
  expectFailure(
    () => verifyZynPackagedBrand({ ...legacyRendererIconFixture, label: 'legacy renderer-icon fixture' }),
    /does not match the reviewed Zyn icon/,
    'packaged verifier accepted a substituted renderer icon',
  );

  const legacyBinaryPathFixture = await createPackagedFixture('legacy-binary-path-package', engine, {
    asarFiles: { 'public/images/Polar-logo.png': Buffer.from('image fixture') },
  });
  expectFailure(
    () => verifyZynPackagedBrand({ ...legacyBinaryPathFixture, label: 'legacy binary-path fixture' }),
    /ASAR\/public\/images\/Polar-logo\.png contains Polar product identity in a packaged path/,
    'packaged verifier accepted a legacy-branded binary asset path',
  );

  const embeddedBackendFixture = await createPackagedFixture('embedded-backend-package', engine, {
    embeddedBackend: true,
  });
  expectFailure(
    () => verifyZynPackagedBrand({ ...embeddedBackendFixture, label: 'embedded backend fixture' }),
    /obsolete embedded backend/,
    'packaged verifier accepted an ASAR backend duplicate',
  );

  const missingWebhookIdentityFixture = await createPackagedFixture('missing-webhook-identity-package', engine, {
    botFiles: {
      'secret-lair-browserless.mjs': zynWebhookSource.replace("username: 'Zyn',", ''),
    },
  });
  expectFailure(
    () => verifyZynPackagedBrand({ ...missingWebhookIdentityFixture, label: 'missing webhook identity fixture' }),
    /secret-lair-browserless\.mjs does not explicitly set the Discord webhook username to Zyn/,
    'packaged verifier accepted an unbranded browserless webhook',
  );

  console.log(JSON.stringify({
    ok: true,
    nativeLegacyMarkers: LEGACY_MARKERS.length,
    nativeRequiredMarkers: REQUIRED_MARKERS.length,
    legacyTextSeeds: legacyTextSamples.length,
    packagedBoundary: result,
  }, null, 2));
}

main().finally(() => fs.rmSync(temporary, { recursive: true, force: true }));
