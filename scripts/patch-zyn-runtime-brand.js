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
});`;
  return source
    .replace(cookieBankAnchor, harvesterIpc)
    .replaceAll('hope://', 'zyn://')
    .replaceAll('Hope', 'Zyn')
    .replace("const DEEP_LINK_SCHEME = 'hope';", "const DEEP_LINK_SCHEME = 'zyn';");
});

rewrite('public/index.html', source => source.replace('<title>Hope</title>', '<title>Zyn</title>'));
rewrite('public/helpers/platform.js', source => source.replaceAll('Hope', 'Zyn'));
rewrite('public/helpers/monitor-parse.js', source => source.replaceAll('Hope', 'Zyn'));
rewrite('public/helpers/discord-monitor.js', source => source.replace(
  'log(`[monitor] listening as ${client.user && client.user.tag} on ${ids.length} channel(s)`);',
  'log(`[monitor] connected on ${ids.length} channel(s)`);',
));

console.log(`Applied Zyn runtime branding in ${root}`);
