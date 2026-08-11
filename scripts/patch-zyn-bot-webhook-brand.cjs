#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const botDir = process.argv[2] && path.resolve(process.argv[2]);
if (!botDir || !fs.existsSync(botDir)) {
  console.error('Usage: patch-zyn-bot-webhook-brand.cjs <packaged-bot-directory>');
  process.exit(2);
}

const avatar = 'https://zynbot.app/zyn-icon.png';

function replaceExactly(source, from, to, expected, label) {
  const count = source.split(from).length - 1;
  if (count !== expected) throw new Error(`Expected ${expected} ${label}, found ${count}`);
  return source.split(from).join(to);
}

function rewrite(name, transform) {
  const file = path.join(botDir, name);
  const before = fs.readFileSync(file, 'utf8');
  const after = transform(before);
  if (after === before) throw new Error(`Zyn webhook branding patch made no change to ${name}`);
  if (/username\s*:\s*["'](?:Hope|Polar AIO)["']/.test(after)) {
    throw new Error(`${name} still contains a legacy webhook username`);
  }
  fs.writeFileSync(file, after, 'utf8');
  console.log(`Applied Zyn webhook branding in ${name}`);
}

rewrite('pbandai-buyer.cjs', source => {
  source = replaceExactly(source, 'a="Hope"', 'a="Zyn"', 1, 'P-Bandai default webhook titles');
  source = replaceExactly(
    source,
    'username:"Hope"',
    `username:"Zyn",avatar_url:"${avatar}"`,
    1,
    'P-Bandai webhook usernames',
  );
  return replaceExactly(
    source,
    'footer:{text:"Hope"}',
    `footer:{text:"Zyn",icon_url:"${avatar}"}`,
    1,
    'P-Bandai webhook footers',
  );
});

rewrite('shared.mjs', source => {
  source = replaceExactly(
    source,
    "username: 'Hope'",
    `username: 'Zyn', avatar_url: '${avatar}'`,
    1,
    'account webhook usernames',
  );
  return replaceExactly(
    source,
    'embeds: [{ title, color, fields, timestamp: new Date().toISOString() }]',
    `embeds: [{ title, color, fields, footer: { text: 'Zyn', icon_url: '${avatar}' }, timestamp: new Date().toISOString() }]`,
    1,
    'account webhook embeds',
  );
});

rewrite('secret-lair-browserless.mjs', source => {
  source = replaceExactly(
    source,
    'body   : JSON.stringify({\n        embeds: [{',
    `body   : JSON.stringify({\n        username: 'Zyn',\n        avatar_url: '${avatar}',\n        embeds: [{`,
    1,
    'browserless webhook payloads',
  );
  return replaceExactly(
    source,
    "footer: { text: 'Secret Lair Bot' },",
    `footer: { text: 'Zyn', icon_url: '${avatar}' },`,
    1,
    'browserless webhook footers',
  );
});

rewrite('round1-register.mjs', source => replaceExactly(
  source,
  'so Hope can run many of these at once:',
  'so Zyn can run many of these at once:',
  1,
  'Round1 product references',
));
