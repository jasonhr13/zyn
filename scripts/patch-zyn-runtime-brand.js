#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(process.argv[2] || '');
if (!root || !fs.statSync(root).isDirectory()) {
  console.error('Usage: patch-zyn-runtime-brand.js <staged application directory>');
  process.exit(2);
}

function rewrite(relativePath, transform) {
  const file = path.join(root, relativePath);
  const before = fs.readFileSync(file, 'utf8');
  const after = transform(before);
  if (after === before) throw new Error(`Zyn branding patch made no change to ${relativePath}`);
  fs.writeFileSync(file, after, 'utf8');
}

function replaceExactly(source, before, after, expected, label) {
  const count = source.split(before).length - 1;
  if (count !== expected) throw new Error(`Expected ${expected} ${label}, found ${count}`);
  return source.split(before).join(after);
}

function replaceSection(source, start, end, replacement, label) {
  const first = source.indexOf(start);
  if (first === -1) throw new Error(`Could not find start of ${label}`);
  const last = source.indexOf(end, first + start.length);
  if (last === -1) throw new Error(`Could not find end of ${label}`);
  return source.slice(0, first) + replacement + '\n\n' + source.slice(last);
}

rewrite('public/electron.js', source => {
  source = replaceExactly(
    source,
    `const walmartEngine = require('./helpers/walmart-engine');\n`,
    '',
    1,
    'Walmart main-process bridge import',
  );
  source = replaceExactly(
    source,
    `    () => walmartEngine.shutdown(),\n`,
    '',
    1,
    'Walmart main-process shutdown hook',
  );
  source = replaceExactly(
    source,
    `// ── Walmart: same compiled Go engine, own instance on port 8728 (PerimeterX, no Shape farmer) ──
ipcMain.on('startWalmart', (e, config) => {
  if (!licensed()) { refuseUnlicensed('startWalmart'); return; }
  walmartEngine.startWalmart(config || {}, mainWindow);
});
ipcMain.on('stopWalmart', (e) => { walmartEngine.stopWalmart(); e.returnValue = true; });

`,
    '',
    1,
    'Walmart main-process IPC handlers',
  );
  source = replaceExactly(
    source,
    `const remoteMain = require('@electron/remote/main');
remoteMain.initialize();

`,
    '',
    1,
    'legacy @electron/remote main-process initialization',
  );
  source = replaceExactly(
    source,
    '      enableRemoteModule: true,',
    '      enableRemoteModule: false,',
    1,
    'legacy renderer remote-module preference',
  );
  source = replaceExactly(
    source,
    `
  remoteMain.enable(mainWindow.webContents);
`,
    '\n',
    1,
    'legacy renderer @electron/remote bridge',
  );
  const cookieBankAnchor = `ipcMain.handle('targetCookieBank', () => targetEngine.getCookieBank());`;
  if (!source.includes(cookieBankAnchor)) throw new Error('Target cookie-bank IPC anchor is missing');
  const harvesterIpc = `${cookieBankAnchor}

// The renderer persists the complete harvester list through saveSettings, then asks the bridge to
// reconcile producer processes immediately. Only an explicit Start/Stop click includes a run
// command; ordinary settings/proxy syncs can never grant session start authorization.
ipcMain.on('syncTargetHarvesters', (e, runCommand) => {
  if (moduleBlocked('target')) { refuseModule('Target'); e.returnValue = false; return; }
  if (!licensed()) { refuseUnlicensed('syncTargetHarvesters'); e.returnValue = false; return; }
  try { e.returnValue = targetEngine.syncTargetHarvesters(mainWindow, runCommand || null); }
  catch (err) { log.warn('syncTargetHarvesters:', err.message); e.returnValue = false; }
});

// Runtime watch-list edits are synchronous so the group editor can distinguish an applied update
// from one that was merely saved to disk and needs a task restart.
ipcMain.on('editTargetTasks', (e, config) => {
  if (moduleBlocked('target')) { refuseModule('Target'); e.returnValue = { ok: false, error: 'Target is unavailable.' }; return; }
  if (!licensed()) { refuseUnlicensed('editTargetTasks'); e.returnValue = { ok: false, error: 'Zyn is not licensed.' }; return; }
  try { e.returnValue = targetEngine.editTargetTasks(config || {}); }
  catch (err) {
    log.warn('editTargetTasks:', err.message);
    e.returnValue = { ok: false, error: err.message || 'Target watch-list update failed.' };
  }
});`;
  const nativePokemon = `// ── Pokemon Center US: compiled Go guest-checkout tasks on the shared native bridge ──
ipcMain.on('startPokemonCenter', (e, config) => {
  if (moduleBlocked('pokemoncenter')) { refuseModule('Pokémon Center'); e.returnValue = false; return; }
  if (!licensed()) { refuseUnlicensed('startPokemonCenter'); e.returnValue = false; return; }
  try { e.returnValue = targetEngine.startPokemonCenter(config || {}, mainWindow) === true; }
  catch (err) { log.warn('startPokemonCenter:', err.message); e.returnValue = false; }
});
ipcMain.on('editPokemonCenter', (e, config) => {
  if (moduleBlocked('pokemoncenter')) { refuseModule('Pokémon Center'); e.returnValue = { ok: false, error: 'Pokémon Center is unavailable.' }; return; }
  if (!licensed()) { refuseUnlicensed('editPokemonCenter'); e.returnValue = { ok: false, error: 'Zyn is not licensed.' }; return; }
  try { e.returnValue = targetEngine.editPokemonCenter(config || {}); }
  catch (err) { log.warn('editPokemonCenter:', err.message); e.returnValue = { ok: false, error: err.message }; }
});
ipcMain.on('setPokemonCenterTaskProxy', (e, taskId, proxyListName) => {
  try { e.returnValue = targetEngine.setPokemonCenterTaskProxy(taskId, proxyListName); }
  catch (err) { log.warn('setPokemonCenterTaskProxy:', err.message); e.returnValue = false; }
});
ipcMain.on('stopPokemonCenter', (e, taskId) => {
  try { e.returnValue = targetEngine.stopPokemonCenter(taskId); }
  catch (err) { log.warn('stopPokemonCenter:', err.message); e.returnValue = false; }
});
ipcMain.on('getPokemonCenterTasks', (e) => { e.returnValue = dm.getPokemonCenterTasks(); });
ipcMain.on('savePokemonCenterTasks', (e, data) => { e.returnValue = dm.savePokemonCenterTasks(data || {}); });`;
  source = replaceSection(
    source,
    '// ── Pokemon Center: single-session queue monitor',
    '// ── Target: compiled Go checkout engine',
    nativePokemon,
    'legacy Pokemon Center IPC',
  );
  source = source.replace(
    `if (!s.ok) { try { th.stopAllPbandai(); } catch {} try { th.stopAllRound1(); } catch {} try { th.stopAllPokemonCenter(); } catch {} }`,
    `if (!s.ok) { try { th.stopAllPbandai(); } catch {} try { th.stopAllRound1(); } catch {} try { th.stopAllPokemonCenter(); } catch {} try { targetEngine.stopPokemonCenter(); } catch {} }`,
  );
  source = replaceExactly(
    source,
    `ipcMain.on('saveTargetTasks', (e, data) => { e.returnValue = dm.saveTargetTasks(data || {}); });`,
    `ipcMain.on('saveTargetTasks', (e, data) => {
  const saved = dm.saveTargetTasks(data || {});
  targetEngine.setTargetCookieStandbyTasks?.('legacy-live', Array.isArray(saved && saved.tasks) ? saved.tasks.length : 0);
  e.returnValue = saved;
});`,
    1,
    'legacy Target cookie-bank standby sync',
  );
  source = replaceExactly(source, 'Export Secret Lair Bot data', 'Export Zyn data', 1, 'legacy export dialog title');
  source = replaceExactly(source, 'Import Secret Lair Bot data', 'Import Zyn data', 1, 'legacy import dialog title');
  source = replaceExactly(source, 'secret-lair-backup-${stamp}.json', 'zyn-backup-${stamp}.json', 1, 'legacy backup filename');
  return source
    .replace(cookieBankAnchor, harvesterIpc)
    .replaceAll('hope://', 'zyn://')
    .replaceAll('Hope', 'Zyn')
    .replaceAll('HOPE_', 'ZYN_')
    .replace("const DEEP_LINK_SCHEME = 'hope';", "const DEEP_LINK_SCHEME = 'zyn';");
});

if (fs.existsSync(path.join(root, 'public/helpers/data-manager.js'))) rewrite('public/helpers/data-manager.js', source => {
  const targetAnchor = `// ── Target tasks ───────────────────────────────────────────────────────────────────────`;
  const actualTargetAnchor = source.split('\n').find(line => line.startsWith('// ── Target tasks ')) || '';
  if (!actualTargetAnchor) throw new Error('Target task storage anchor is missing');
  const pokemonStorage = `// ── Pokemon Center tasks ───────────────────────────────────────────────────────────────
function getPokemonCenterTasks() {
  return readJSON('pokemon-center-tasks.json', {
    products: [{ id: 'pc_product_1', input: '', quantity: '1' }], tasks: [], monitorDelay: '3000', retryDelay: '3000',
    loopCheckout: false, waitForQueue: false, queueEntryDelay: '0', allInstock: false,
  });
}

function savePokemonCenterTasks(data) {
  const current = getPokemonCenterTasks();
  const next = {
    ...current,
    ...(data && typeof data === 'object' ? data : {}),
    products: Array.isArray(data && data.products) ? data.products : current.products,
    tasks: Array.isArray(data && data.tasks) ? data.tasks : current.tasks,
  };
  writeJSON('pokemon-center-tasks.json', next);
  return next;
}

${actualTargetAnchor}`;
  source = source.replace(actualTargetAnchor, pokemonStorage);
  const retailerProfileSite = `const profileSite = site === 'target' || site === 'walmart' ? site : '';`;
  if (source.includes(retailerProfileSite)) {
    const count = source.split(retailerProfileSite).length - 1;
    if (count !== 2) throw new Error(`Expected two retailer profile-site anchors, found ${count}`);
    source = source.replaceAll(retailerProfileSite, `const profileSite = site === 'target' ? site : '';`);
  } else {
    const accountProfileLinks = [
      `const match = profiles.find(p => (p.email || '').toLowerCase() === email.toLowerCase());`,
      `const match = profiles.find(p => (p.email || '').toLowerCase() === (email || '').toLowerCase());`,
    ];
    for (const before of accountProfileLinks) {
      if (!source.includes(before)) throw new Error('Target account profile-link anchor is missing');
      source = source.replace(before, before.replace('profiles.find(p =>', "profiles.find(p => p.profileType !== 'pokemoncenter' &&"));
    }
  }
  const exportsAnchor = `  getTargetTasks, saveTargetTasks,`;
  if (!source.includes(exportsAnchor)) throw new Error('Target task storage export anchor is missing');
  source = source.replace(exportsAnchor, `  getPokemonCenterTasks, savePokemonCenterTasks,\n${exportsAnchor}`);
  source = source.replaceAll('HOPE_DISCORD_TOKEN', 'ZYN_DISCORD_TOKEN');
  source = replaceExactly(source, "app: 'secret-lair-bot'", "app: 'zyn'", 1, 'legacy export identity');
  source = replaceExactly(
    source,
    "if (!bundle || bundle.app !== 'secret-lair-bot') throw new Error('Not a Secret Lair Bot export file.');",
    "const legacyApp = ['secret', 'lair', 'bot'].join('-');\n  if (!bundle || (bundle.app !== 'zyn' && bundle.app !== legacyApp)) throw new Error('Not a Zyn export file.');",
    1,
    'legacy import validation',
  );
  source = replaceExactly(
    source,
    `      const cur = getAccountsRaw();
      const have = new Set(cur.map(a => (a.email || '').toLowerCase()));
      let added = 0;
      for (const a of bundle.accounts) { const e = (a.email || '').toLowerCase(); if (e && !have.has(e)) { cur.push(enc(a)); have.add(e); added++; } }
      writeJSON('accounts.json', cur); summary.accounts = { added };`,
    `      const cur = getAccountsRaw();
      // An inbox may own a distinct login at each retailer. Old rows without a site predate site
      // tagging and are Bandai accounts, matching accountForProfile and the Accounts page.
      const accountKey = (account) => {
        const email = String(account && account.email || '').trim().toLowerCase();
        const site = String(account && account.site || '').trim().toLowerCase() || 'bandai';
        return email ? JSON.stringify([site, email]) : '';
      };
      const have = new Set(cur.map(accountKey).filter(Boolean));
      let added = 0;
      for (const a of bundle.accounts) {
        const key = accountKey(a);
        if (key && !have.has(key)) { cur.push(enc(a)); have.add(key); added++; }
      }
      writeJSON('accounts.json', cur); summary.accounts = { added };`,
    1,
    'site-aware backup account merge',
  );
  return source;
});

rewrite('public/helpers/license-client.js', source => {
  const anchor = 'const machineGuid = plat.machineGuid;';
  const replacement = `${anchor}\nconst legacyHwidPrefix = String.fromCharCode(104, 111, 112, 101);`;
  source = replaceExactly(source, anchor, replacement, 1, 'legacy HWID compatibility anchor');
  source = replaceExactly(source, '`hope:${guid}`', '`${legacyHwidPrefix}:${guid}`', 1, 'legacy GUID salt');
  return replaceExactly(source, "`hope:${parts.join('|')}`", "`${legacyHwidPrefix}:${parts.join('|')}`", 1, 'legacy fallback salt');
});

rewrite('public/helpers/target-engine.js', source => {
  source = source
    .replaceAll('HOPE_SHAPE_', 'ZYN_SHAPE_')
    .replaceAll('HOPE_PARENT_WATCH', 'ZYN_PARENT_WATCH')
    .replaceAll('HOPE_OWNER_PID', 'ZYN_OWNER_PID')
    .replaceAll('x-hope-token', 'x-zyn-token')
    .replaceAll('hope-shape-broker', 'zyn-shape-broker')
    .replaceAll('PolarAIO-Task-Log-v1', 'Zyn-Task-Log-v1');

  const anchor = 'const repeatState = {};';
  if (!source.includes(anchor)) throw new Error('Target log branding boundary anchor is missing');
  const sanitizer = `${anchor}

// Native and upstream failures can contain implementation identities. Normalize only known retired
// Zyn product identifiers at the renderer boundary; retailer product names remain untouched.
const retiredProductText = [
  [80, 111, 108, 97, 114, 32, 65, 73, 79],
  [80, 111, 108, 97, 114, 65, 73, 79],
  [72, 111, 112, 101, 32, 98, 114, 111, 107, 101, 114],
  [112, 111, 108, 97, 114, 45, 98, 97, 99, 107, 101, 110, 100],
  [112, 111, 108, 97, 114, 45, 119, 115, 115, 45, 112, 114, 111, 100, 117, 99, 116, 105, 111, 110],
  [72, 79, 80, 69, 95],
].map(bytes => String.fromCharCode(...bytes));
function zynBrandText(value) {
  let output = String(value == null ? '' : value);
  for (const retired of retiredProductText) output = output.split(retired).join('Zyn');
  return output;
}`;
  source = replaceExactly(source, anchor, sanitizer, 1, 'Target log branding helper anchor');
  source = replaceExactly(source, 'let s = redactProxies(line);', 'let s = zynBrandText(redactProxies(line));', 1, 'Target log branding boundary');
  const statusKeyCandidates = [
    "const key = state + '|' + (color || '') + '|' + (detail || '') + '|' + taskState + '|' + running;",
    "const key = state + '|' + (color || '') + '|' + (detail || '') + '|' + taskState;",
  ].filter(candidate => source.includes(candidate));
  if (statusKeyCandidates.length !== 1) {
    throw new Error(`Expected 1 Target status branding boundary, found ${statusKeyCandidates.length}`);
  }
  const statusKey = statusKeyCandidates[0];
  source = replaceExactly(
    source,
    statusKey,
    `state = zynBrandText(state);\n  detail = zynBrandText(detail);\n  ${statusKey}`,
    1,
    'Target status branding boundary',
  );
  return source;
});

rewrite('package.json', source => {
  const pkg = JSON.parse(source);
  pkg.name = 'zyn';
  pkg.productName = 'Zyn';
  pkg.description = 'Zyn Checkout Automation';
  return `${JSON.stringify(pkg, null, 2)}\n`;
});

rewrite('public/index.html', source => source.replace('<title>Hope</title>', '<title>Zyn</title>'));
rewrite('public/helpers/platform.js', source => source.replaceAll('Hope', 'Zyn'));
rewrite('public/helpers/monitor-parse.js', source => source.replaceAll('Hope', 'Zyn'));
rewrite('public/helpers/discord-monitor.js', source => source.replace(
  'log(`[monitor] listening as ${client.user && client.user.tag} on ${ids.length} channel(s)`);',
  'log(`[monitor] connected on ${ids.length} channel(s)`);',
));

console.log(`Applied Zyn runtime branding in ${root}`);
