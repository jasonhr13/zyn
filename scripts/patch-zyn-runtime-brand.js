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

function replaceSection(source, start, end, replacement, label) {
  const first = source.indexOf(start);
  if (first === -1) throw new Error(`Could not find start of ${label}`);
  const last = source.indexOf(end, first + start.length);
  if (last === -1) throw new Error(`Could not find end of ${label}`);
  return source.slice(0, first) + replacement + '\n\n' + source.slice(last);
}

rewrite('public/electron.js', source => {
  const cookieBankAnchor = `ipcMain.handle('targetCookieBank', () => targetEngine.getCookieBank());`;
  if (!source.includes(cookieBankAnchor)) throw new Error('Target cookie-bank IPC anchor is missing');
  const harvesterIpc = `${cookieBankAnchor}

// The renderer persists the complete harvester list through saveSettings, then asks the bridge to
// reconcile producer processes immediately. Schedules are also rechecked every 15 seconds.
ipcMain.on('syncTargetHarvesters', (e) => {
  if (moduleBlocked('target')) { refuseModule('Target'); e.returnValue = false; return; }
  if (!licensed()) { refuseUnlicensed('syncTargetHarvesters'); e.returnValue = false; return; }
  try { e.returnValue = targetEngine.syncTargetHarvesters(mainWindow); }
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
  return source
    .replace(cookieBankAnchor, harvesterIpc)
    .replaceAll('hope://', 'zyn://')
    .replaceAll('Hope', 'Zyn')
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
  const accountProfileLinks = [
    `const match = profiles.find(p => (p.email || '').toLowerCase() === email.toLowerCase());`,
    `const match = profiles.find(p => (p.email || '').toLowerCase() === (email || '').toLowerCase());`,
  ];
  for (const before of accountProfileLinks) {
    if (!source.includes(before)) throw new Error('Target account profile-link anchor is missing');
    source = source.replace(before, before.replace('profiles.find(p =>', "profiles.find(p => p.profileType !== 'pokemoncenter' &&"));
  }
  const exportsAnchor = `  getTargetTasks, saveTargetTasks,`;
  if (!source.includes(exportsAnchor)) throw new Error('Target task storage export anchor is missing');
  return source.replace(exportsAnchor, `  getPokemonCenterTasks, savePokemonCenterTasks,\n${exportsAnchor}`);
});

rewrite('public/index.html', source => source.replace('<title>Hope</title>', '<title>Zyn</title>'));
rewrite('public/helpers/platform.js', source => source.replaceAll('Hope', 'Zyn'));
rewrite('public/helpers/monitor-parse.js', source => source.replaceAll('Hope', 'Zyn'));
rewrite('public/helpers/discord-monitor.js', source => source.replace(
  'log(`[monitor] listening as ${client.user && client.user.tag} on ${ids.length} channel(s)`);',
  'log(`[monitor] connected on ${ids.length} channel(s)`);',
));

console.log(`Applied Zyn runtime branding in ${root}`);
