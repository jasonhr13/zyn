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

rewrite('public/electron.js', source => source
  .replaceAll('hope://', 'zyn://')
  .replaceAll('Hope', 'Zyn')
  .replace("const DEEP_LINK_SCHEME = 'hope';", "const DEEP_LINK_SCHEME = 'zyn';"));

rewrite('public/index.html', source => source.replace('<title>Hope</title>', '<title>Zyn</title>'));
rewrite('public/helpers/platform.js', source => source.replaceAll('Hope', 'Zyn'));
rewrite('public/helpers/monitor-parse.js', source => source.replaceAll('Hope', 'Zyn'));
rewrite('public/helpers/discord-monitor.js', source => source.replace(
  'log(`[monitor] listening as ${client.user && client.user.tag} on ${ids.length} channel(s)`);',
  'log(`[monitor] connected on ${ids.length} channel(s)`);',
));

console.log(`Applied Zyn runtime branding in ${root}`);
