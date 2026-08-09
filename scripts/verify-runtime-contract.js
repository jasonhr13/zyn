#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const projectDir = path.resolve(__dirname, '..');
const appPath = process.argv[2] && path.resolve(process.argv[2]);
const contractPath = path.join(projectDir, 'config', 'runtime-contract.json');

if (!appPath || !fs.existsSync(appPath)) {
  console.error('Usage: node scripts/verify-runtime-contract.js <Zyn.app>');
  process.exit(2);
}

const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
const failures = [];

function check(label, operation) {
  try {
    operation();
  } catch (error) {
    failures.push(`${label}: ${error.message}`);
  }
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function plistValue(key) {
  return execFileSync('plutil', [
    '-extract', key, 'raw', path.join(appPath, 'Contents', 'Info.plist'),
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function fileDescription(file) {
  return execFileSync('file', ['-b', file], { encoding: 'utf8' }).trim();
}

let runtimeMode = 'bundled';
let runtimeModeDeclared = false;
try { runtimeMode = plistValue('ZynRuntimeMode'); runtimeModeDeclared = true; } catch {}
const remoteRuntime = runtimeMode === 'remote';
const remoteRoots = contract.remoteRuntime?.excludedResourceRoots || [];
const isRemoteRuntimeResource = relative => remoteRoots.some(root => relative === root || relative.startsWith(`${root}/`));

for (const resource of remoteRuntime ? [] : contract.immutableResources) {
  check(resource.path, () => {
    const file = path.join(appPath, resource.path);
    assert.equal(fs.statSync(file).isFile(), true, 'is not a regular file');
    assert.equal(sha256(file), resource.sha256, 'SHA-256 does not match the frozen contract');
  });
}

for (const relative of contract.requiredResources) {
  if (remoteRuntime && isRemoteRuntimeResource(relative)) continue;
  if (!runtimeModeDeclared && relative === 'Contents/Resources/app/runtime-manager.js') continue;
  check(relative, () => assert.equal(fs.existsSync(path.join(appPath, relative)), true, 'is missing'));
}

for (const link of remoteRuntime ? [] : contract.symlinks) {
  check(link.path, () => {
    const file = path.join(appPath, link.path);
    assert.equal(fs.lstatSync(file).isSymbolicLink(), true, 'is not a symbolic link');
    assert.equal(fs.readlinkSync(file), link.target, 'points at the wrong target');
  });
}

const product = contract.product;
const plistChecks = {
  CFBundleDisplayName: product.name,
  CFBundleName: product.name,
  CFBundleExecutable: product.name,
  CFBundleIconFile: 'Zyn.icns',
  CFBundleShortVersionString: product.version,
  CFBundleIdentifier: product.bundleIdentifier,
  'CFBundleURLTypes.0.CFBundleURLName': product.name,
  'CFBundleURLTypes.0.CFBundleURLSchemes.0': 'zyn',
  ZynElectronVersion: product.electronVersion,
  ZynReactVersion: product.reactVersion,
  ZynRelease: contract.appRelease,
};
for (const [key, expected] of Object.entries(plistChecks)) {
  check(`Info.plist ${key}`, () => assert.equal(plistValue(key), expected));
}

const appArch = plistValue('ZynArchitecture');
check('Info.plist ZynArchitecture', () => {
  assert.ok(product.supportedArchitectures.includes(appArch), `unsupported architecture ${appArch}`);
});
check('Info.plist ZynRuntimeMode', () => {
  assert.ok(['remote', 'bundled'].includes(runtimeMode), `unsupported runtime delivery ${runtimeMode}`);
});
check('Zyn executable architecture', () => {
  const description = fileDescription(path.join(appPath, 'Contents', 'MacOS', 'Zyn'));
  assert.match(description, appArch === 'x64' ? /x86_64/ : /arm64/);
});
const nativeEngine = contract.nativeEngines[appArch];
check('native Target backend', () => {
  assert.ok(nativeEngine, `no native backend contract for ${appArch}`);
  const file = path.join(appPath, nativeEngine.path);
  assert.equal(sha256(file), nativeEngine.sha256, 'SHA-256 does not match the architecture contract');
  assert.match(fileDescription(file), appArch === 'x64' ? /Mach-O.*x86_64/ : /Mach-O.*arm64/);
});

check('feature flags', () => {
  const flagsPath = path.join(appPath, 'Contents', 'Resources', 'app', 'feature-flags.js');
  const { APP_RELEASE, FEATURES } = require(flagsPath);
  assert.equal(APP_RELEASE, contract.appRelease);
  assert.deepEqual(FEATURES, contract.features, 'packaged feature flags do not match the release contract');
});

check('launcher package identity', () => {
  const launcherPackage = JSON.parse(fs.readFileSync(
    path.join(appPath, 'Contents', 'Resources', 'app', 'package.json'),
    'utf8',
  ));
  assert.equal(launcherPackage.name, 'zyn-macos-launcher');
  assert.equal(launcherPackage.productName, 'Zyn');
});

check('Zyn runtime branding', () => {
  const asar = require(path.join(projectDir, 'frontend', 'node_modules', '@electron', 'asar'));
  const archive = path.join(appPath, 'Contents', 'Resources', 'app-original.asar');
  const electronMain = asar.extractFile(archive, 'public/electron.js').toString('utf8');
  const discordMonitor = asar.extractFile(archive, 'public/helpers/discord-monitor.js').toString('utf8');
  const targetEngine = asar.extractFile(archive, 'public/helpers/target-engine.js').toString('utf8');
  const dataManager = asar.extractFile(archive, 'public/helpers/data-manager.js').toString('utf8');
  const nativeEngineContract = asar.extractFile(
    archive,
    'public/helpers/native-engine-contract.js',
  ).toString('utf8');
  const nativeHyperBroker = asar.extractFile(
    archive,
    'public/helpers/native-hyper-broker.js',
  ).toString('utf8');
  const manualCaptchaManager = asar.extractFile(
    archive,
    'public/helpers/manual-captcha-manager.js',
  ).toString('utf8');
  const queueEvents = fs.readFileSync(
    path.join(appPath, 'Contents', 'Resources', 'app', 'pokemon-queue-events.js'),
    'utf8',
  );
  assert.match(electronMain, /const DEEP_LINK_SCHEME = 'zyn';/);
  assert.match(electronMain, /ipcMain\.on\('editTargetTasks'/,
    'packaged Electron main process omits live Target task editing');
  assert.doesNotMatch(electronMain, /\bHope\b|hope:\/\//i);
  assert.match(discordMonitor, /\[monitor\] connected on/);
  assert.doesNotMatch(discordMonitor, /listening as/);
  assert.match(targetEngine, /require\('\.\/native-engine-contract'\)/,
    'packaged Target bridge does not use the shared native-engine contract');
  assert.match(targetEngine, /new engineContract\.TaskSiteRegistry\(\)/,
    'packaged Target bridge does not track site ownership for shared-engine tasks');
  assert.match(targetEngine, /nativeHyperBroker\.handleEnvelope\(msg/,
    'packaged native engine bridge does not route Hyper requests');
  assert.match(targetEngine, /manualCaptchaManager\.handleEnvelope\(msg/,
    'packaged native engine bridge does not route manual captcha requests');
  assert.match(targetEngine, /function validatePokemonProducts\(/,
    'packaged Pokémon Center bridge omits per-product quantities');
  assert.match(targetEngine, /quantity: product\.quantity/,
    'packaged Pokémon Center bridge drops per-product quantities');
  assert.match(targetEngine, /billingFirstName: billingFirst/,
    'packaged profile bridge drops the separate billing address');
  assert.match(targetEngine, /const queueMonitorLog = decoded\.startsWith\('\[queue-monitor\]'\)/,
    'packaged Pokémon Center bridge hides safe queue-monitor health logs');
  assert.match(targetEngine, /function publishPokemonQueueProtection/,
    'packaged Pokémon Center bridge omits normalized push events');
  assert.match(targetEngine, /function setPokemonQueueStreamHealth/,
    'packaged Pokémon Center bridge omits push-stream health logs');
  assert.match(targetEngine, /loopCheckout: \(t\.loopCheckout != null/,
    'packaged Target bridge drops the loop-checkout contract flag');
  assert.match(targetEngine, /endless: \(t\.loopCheckout != null/,
    'packaged Target bridge does not activate native continuous checkout');
  assert.match(targetEngine, /function enforceTargetLoopCheckout\(/,
    'packaged Target bridge lets looping tasks bypass the order cap');
  assert.match(dataManager, /products: Array\.isArray/,
    'packaged Pokémon Center storage omits product rows');
  assert.match(nativeHyperBroker, /authority\.hyper\(request\.operation, request\.payload\)/,
    'packaged Hyper bridge bypasses the main-process license authority');
  assert.match(manualCaptchaManager, /manual captcha is restricted to Pokemon Center US/,
    'packaged captcha manager does not constrain manual solves to Pokemon Center US');
  assert.match(manualCaptchaManager, /nodeIntegration: false/,
    'packaged captcha window enables renderer Node integration');
  assert.match(nativeEngineContract, /const PROTOCOL_VERSION = 1;/,
    'packaged native-engine protocol version is missing');
  assert.match(nativeEngineContract, /POKEMON_CENTER_US: 'Pokemon Center US'/,
    'packaged native-engine contract omits Pokemon Center US');
  assert.match(queueEvents, /authority\.openPokemonQueueEvents/,
    'packaged queue event client bypasses the license authority');
  assert.doesNotMatch(queueEvents, /polar-wss-production|licenseKey|siteConfigs/,
    'packaged queue event client contains upstream secrets or unrelated cloud handling');
});

check('build receipt', () => {
  const receipt = JSON.parse(fs.readFileSync(
    path.join(appPath, 'Contents', 'Resources', 'zyn-build.json'),
    'utf8',
  ));
  assert.equal(receipt.release, contract.appRelease);
  assert.equal(receipt.product.bundleIdentifier, product.bundleIdentifier);
  assert.equal(receipt.product.arch, appArch);
  assert.equal(receipt.runtime.backendSha256, nativeEngine.sha256);
  assert.equal(receipt.runtime.delivery || 'bundled', runtimeMode);
  assert.equal(receipt.runtime.manifest || '', remoteRuntime ? contract.remoteRuntime.manifest : '');
  assert.deepEqual(receipt.features, contract.features);
});

check('Target farmer New Headless launch contract', () => {
  const resources = path.join(appPath, 'Contents', 'Resources');
  const farmer = fs.readFileSync(path.join(resources, 'bot', 'shape-farmer.mjs'), 'utf8');
  const browserPool = fs.readFileSync(path.join(resources, 'bot', 'shape-browser-pool.mjs'), 'utf8');
  const upstream = JSON.parse(fs.readFileSync(path.join(projectDir, 'config', 'native-farmer-upstream.json'), 'utf8'));
  for (const [filename, entry] of Object.entries(upstream.files)) {
    if (!filename.endsWith('.mjs') && filename !== 'target-atc-v2.html') continue;
    const expected = typeof entry === 'string' ? entry : entry.sha256;
    assert.equal(sha256(path.join(resources, 'bot', filename)), expected,
      `${filename} no longer matches pinned ${upstream.commit}`);
  }
  for (const key of ['chrome', 'msedge', 'brave', 'vivaldi', 'yandex', 'chromium']) {
    assert.match(browserPool, new RegExp(`key: '${key}'`), `native browser pool omits ${key}`);
  }
  assert.match(browserPool, /channel: 'chromium'/, 'Chromium-family browsers lack an explicit full-browser channel');

  const asar = require(path.join(projectDir, 'frontend', 'node_modules', '@electron', 'asar'));
  const targetEngine = asar.extractFile(path.join(resources, 'app-original.asar'), 'public/helpers/target-engine.js').toString('utf8');
  const runtimePaths = asar.extractFile(path.join(resources, 'app-original.asar'), 'public/helpers/runtime-paths.js').toString('utf8');
  assert.match(targetEngine, /'--headless=true'/, 'Zyn does not request headless mode');
  assert.doesNotMatch(targetEngine, /'--headless=false'/, 'Zyn still requests headed mode');
  assert.match(targetEngine, /const findNodeExe = nodeExecutable/, 'Target farmer does not use native Node boundary');
  assert.match(targetEngine, /process\.resourcesPath[\s\S]{0,160}'engine'/,
    'Target engine does not resolve the bundled native backend');
  assert.match(targetEngine, /nodeEnvironment\(\{ FORCE_COLOR/, 'Target farmer does not use native environment');
  assert.match(runtimePaths, /ELECTRON_RUN_AS_NODE = '1'/, 'packaged farmer does not reuse Electron as Node');
  assert.match(targetEngine, /`--capturesPerLoad=\$\{capturesPerLoad\}`/, 'Zyn omits cookies-per-page');
  assert.match(targetEngine, /`--loadsPerBrowser=\$\{loadsPerBrowser\}`/, 'Zyn omits browser reuse');
  assert.match(targetEngine, /`--blockHeavyResources=\$\{blockHeavyResources\}`/, 'Zyn omits bandwidth control');
  assert.match(targetEngine, /`--browsers=auto`/, 'Zyn does not request the six-browser pool');
  assert.match(targetEngine, /`--sessionReady=\$\{hasSession\}`/, 'Zyn omits cold-login coordination');
  assert.match(targetEngine, /signalFarmerSessionReady\(\)/, 'Zyn omits session-ready handoff');
  assert.match(farmer, /bag\.length >= CAPTURES_PER_LOAD/, 'farmer lacks multi-capture');
  assert.match(farmer, /randomLoadsForBrowser\(LOADS_PER_BROWSER\)/, 'farmer lacks browser reuse');
  assert.match(farmer, /argOf\('blockHeavyResources', 'true'\)/, 'farmer lacks heavy-resource blocking');
  assert.match(farmer, /activeWorkers: scale\.activeWorkers/, 'farmer omits resolved worker count');
  assert.match(farmer, /configuredWorkers: startedWorkerCount/, 'farmer omits configured worker count');
  assert.match(targetEngine, /health: j\.health \|\| null/, 'Zyn drops broker worker health');
  assert.match(targetEngine, /lastBankedAt: latestBankedAt\(\)/, 'Zyn drops latest bank success time');
  assert.match(targetEngine, /function editTargetTasks\(config = \{\}\)/,
    'Target bridge omits live task watch-list editing');
  assert.match(targetEngine, /type: 'edit-tasks', messages/,
    'Target bridge does not send native runtime edits');
  assert.match(targetEngine, /MONITOR_ID \+ '-edit-'/,
    'Target bridge does not refresh newly edited SKUs in shared-monitor mode');
  assert.match(targetEngine, /loopCheckout: \(t\.loopCheckout != null/,
    'Target bridge drops the loop-checkout contract flag');
  assert.match(targetEngine, /endless: \(t\.loopCheckout != null/,
    'Target bridge does not activate native continuous checkout');
  assert.match(targetEngine, /function enforceTargetLoopCheckout\(/,
    'Target bridge lets looping tasks bypass the order cap');

  const manifest = JSON.parse(asar.extractFile(path.join(resources, 'app-original.asar'), 'build/asset-manifest.json').toString('utf8'));
  const rendererBundlePath = `build/${manifest.files['main.js'].replace(/^\.\//, '')}`;
  const rendererBundle = asar.extractFile(path.join(resources, 'app-original.asar'), rendererBundlePath).toString('utf8');
  assert.match(rendererBundle, /Zyn/, 'packaged renderer omits the Zyn brand');
  assert.doesNotMatch(rendererBundle, /\bHope\b|\bPolar\b|control[ -]plane/i, 'packaged renderer retains retired branding');
  assert.match(rendererBundle, /Profile Type/, 'packaged Profiles UI omits retailer-specific profile types');
  assert.match(rendererBundle, /Billing address is the same as shipping/,
    'packaged Profiles UI omits the billing-address control');
  assert.match(rendererBundle, /Add product/, 'packaged Pokémon Center UI omits product rows');
  assert.match(rendererBundle, /Edit task products/, 'packaged Pokémon Center UI omits per-task product editing');
  assert.match(rendererBundle, /Save & update task/, 'packaged Pokémon Center UI cannot apply queued-task product edits');
  assert.match(rendererBundle, /HTTPS queue-status endpoint every three seconds/,
    'packaged Pokémon Center UI does not explain queue-monitor health logging');
  assert.match(rendererBundle, /Cookies per page load/, 'packaged Settings omits cookies-per-page');
  assert.match(rendererBundle, /Page loads per browser/, 'packaged Settings omits browser reuse');
  assert.match(rendererBundle, /Block images, video & fonts while farming/, 'packaged Settings omits bandwidth control');
  assert.match(rendererBundle, /Starting broker/, 'packaged task groups omit broker startup state');
  assert.match(rendererBundle, /only this task/, 'packaged task groups omit per-task logs');
  assert.match(rendererBundle, /editTargetTasks/, 'packaged task groups omit live SKU editing');
  assert.match(rendererBundle, /Loop checkout by default/, 'packaged task groups omit loop checkout controls');
  assert.match(rendererBundle, /Shared Cookie Bank/, 'packaged task groups omit the shared cookie bank');
  assert.match(rendererBundle, /Harvesters stopped/, 'packaged task groups omit the stopped-harvester bank state');
  assert.match(rendererBundle, /Broker online/, 'packaged task groups do not distinguish broker reachability');
  assert.match(rendererBundle, /Open Cookie Harvesters/, 'packaged task groups omit the collapsed harvester rail');
  assert.match(rendererBundle, /Close Cookie Harvesters/, 'packaged task groups omit the harvester drawer');
  assert.match(rendererBundle, /Active workers/, 'packaged harvester drawer omits progress totals');
  assert.doesNotMatch(rendererBundle, /Run output|Cooling routes|Top failure/,
    'packaged cookie bank retains obsolete single-farmer diagnostics');
  assert.doesNotMatch(rendererBundle, /R2 groups existing Target controls only/, 'packaged task groups retain the stale R2 boundary');

  const browsers = JSON.parse(fs.readFileSync(path.join(resources, 'node_modules', 'playwright-core', 'browsers.json'), 'utf8'));
  const chromium = browsers.browsers.find((browser) => browser.name === 'chromium');
  assert.ok(chromium, 'regular Chromium descriptor is missing');
  if (remoteRuntime) {
    for (const root of remoteRoots) {
      assert.equal(fs.existsSync(path.join(appPath, root)), false, `${root} should not be in a remote-runtime build`);
    }
    const manager = fs.readFileSync(path.join(resources, 'app', 'runtime-manager.js'), 'utf8');
    assert.match(manager, /zyn-manifest-v1\.json/, 'remote runtime manager uses the wrong manifest protocol');
    assert.match(manager, /verifyManifest/, 'remote runtime manager does not verify signed manifests');
    assert.match(manager, /bytes=\$\{existing\}-/, 'remote runtime manager does not resume partial downloads');
    assert.match(manager, /darwin: \['chromium'\]/, 'remote runtime downloads more than native Chromium');
    assert.doesNotMatch(manager, /EXPECTED_ENGINE_SHA256|EXPECTED_WINE_VERSION/,
      'remote runtime still pins the Windows engine or Wine');
    const bootstrap = fs.readFileSync(path.join(resources, 'app', 'bootstrap.js'), 'utf8');
    assert.match(bootstrap, /waitForRuntime\(\['chromium'\]\)/,
      'Target launches do not wait for the remote Chromium component');
    assert.match(bootstrap, /status && status\.ok === true\)[\s\S]{0,120}beginRuntimeBootstrap\(\)/,
      'runtime download does not begin after license sign-in');
  } else {
    assert.equal(
      fs.existsSync(path.join(resources, 'vendor', 'ms-playwright', `chromium-${chromium.revision}`, 'chrome-win64', 'chrome.exe')),
      true,
      'regular Chromium executable is missing',
    );
    const nativeChromium = path.join(resources, 'vendor', 'ms-playwright-mac', `chromium-${chromium.revision}`);
    assert.equal(fs.existsSync(nativeChromium), true, 'native regular Chromium revision is missing');
    const nativeFolder = appArch === 'x64' ? 'chrome-mac-x64' : 'chrome-mac-arm64';
    const nativeExecutable = [
      path.join(nativeChromium, nativeFolder, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
      path.join(nativeChromium, nativeFolder, 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
      path.join(nativeChromium, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
    ].find(candidate => fs.existsSync(candidate));
    assert.ok(nativeExecutable, 'native regular Chromium executable is missing');
    assert.match(fileDescription(nativeExecutable), appArch === 'x64' ? /x86_64/ : /arm64/,
      'native Chromium architecture does not match the app');
    assert.equal(
      fs.readdirSync(path.join(resources, 'vendor', 'ms-playwright-mac'))
        .some(name => name.startsWith('chromium_headless_shell-')),
      false,
      'legacy Chromium headless shell must not be bundled',
    );
  }
  const coreBundle = fs.readFileSync(path.join(resources, 'node_modules', 'playwright-core', 'lib', 'coreBundle.js'), 'utf8');
  assert.match(coreBundle, /options\.channel && registry\.isChromiumAlias\(options\.channel\)[\s\S]{0,80}return "chromium"/, 'Playwright does not map the chromium channel to regular Chromium');
});

check('architecture-specific auto-update feed', () => {
  const resources = path.join(appPath, 'Contents', 'Resources');
  const updateConfig = fs.readFileSync(path.join(resources, 'app-update.yml'), 'utf8');
  const bootstrap = fs.readFileSync(path.join(resources, 'app', 'bootstrap.js'), 'utf8');
  assert.match(updateConfig, new RegExp(`url: https://updates\\.rcart\\.app/mac/${appArch}`));
  assert.match(updateConfig, new RegExp(`updaterCacheDirName: zyn-updater-${appArch}`));
  assert.match(bootstrap, /process\.arch === 'x64' \? 'x64' : 'arm64'/);
  assert.match(bootstrap, /autoUpdater\.setFeedURL\(\{ provider: 'generic', url: updateUrl \}\)/);
  assert.doesNotMatch(bootstrap, /disableWindowsOnlyUpdater/);
});

if (failures.length) {
  console.error(`Runtime contract failed for ${appPath}:`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  app: appPath,
  release: contract.appRelease,
  arch: appArch,
  immutableResources: contract.immutableResources.length,
  runtimeMode,
  requiredResources: contract.requiredResources.length,
  windowsLaunchers: contract.windowsLaunchers,
}, null, 2));
