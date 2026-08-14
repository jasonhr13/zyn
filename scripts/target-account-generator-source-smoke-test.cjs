#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const target = read('bot-runtime/target-register.mjs');
const shared = read('bot-runtime/shared.mjs');
const generator = read('frontend/src/components/pages/target-account-generator.js');
const accounts = read('frontend/src/components/pages/accounts.js');
const router = read('frontend/src/components/page-handler.js');
const settings = read('frontend/src/components/pages/settings.js');
const manifest = JSON.parse(read('config/account-generator-upstream.json'));

assert.equal(manifest.repository, 'https://github.com/z04231992/secret-lair-releases');
assert.equal(manifest.release, 'v1.6.78');
assert.equal(manifest.upstreamFiles['resources/bot/target-register.mjs'],
  '29c1485069fe861e8b469291a791384cb805658500834ee1b75bd398d401418e');

assert.doesNotMatch(target, /argOf\(['"]sms|CONFIG\.sms|CONFIG\.phone/);
assert.match(target, /requires --proxyServer/);
assert.match(target, /fromFilter: 'target\.com'/);
assert.match(target, /submitStatus === 201/);
assert.match(target, /headless:\s*false/);
assert.doesNotMatch(target, /headless:\s*true/);
assert.doesNotMatch(shared, /ACCOUNT_GLOBAL_WEBHOOK|discord\.com\/api\/webhooks\/\d+/);
assert.match(shared, /username: 'Zyn'/);
assert.match(shared, /avatar_url: 'https:\/\/zynbot\.app\/zyn-icon\.png'/);
assert.match(shared, /sendWebhook\(webhookUrl/);

assert.match(accounts, /import TargetAccountGenerator from '\.\/target-account-generator'/);
assert.match(accounts, /Generate Accounts/);
assert.match(accounts, /<TargetAccountGenerator/);
assert.match(router, /<Route path="\/accounts" component=\{Accounts\}/);
assert.match(generator, /runBotScript', 'target-register\.mjs'/);
assert.match(generator, /Target generation requires a proxy list/);
assert.match(generator, /settings\.accountGenWebhook/);
assert.match(generator, /managedProxyRef/);
assert.match(generator, /Automatic — random installed browser/);
assert.match(generator, /--browser=\$\{this\.state\.browser/);
assert.match(target, /generationLaunchOptions/);
assert.match(target, /Launching headed \$\{selectedBrowser\.label\}/);
assert.match(generator, /Target signup does not use SMS or an address/);
assert.match(generator, /Create matching profiles from/);
assert.match(generator, /generatedProfilesFromTemplate/);
assert.match(generator, /jigShipping/);
assert.match(generator, /Jig shipping line 1 and line 2/);
assert.match(generator, /card billing address stay exactly as on the template/);
assert.match(generator, /IMAP mailbox email/);
assert.match(generator, /not the random catchall/);
assert.match(generator, /imapUser\.trim\(\) && this\.state\.imapPass && this\.effectiveImapHost\(\)/);
assert.match(generator, /profilesCreated/);
assert.doesNotMatch(generator, /smsProvider|smsApiKey|discordWebhook/);
assert.match(settings, /Account Generation Webhook URL/);
assert.match(settings, /accountGenWebhook/);

for (const build of ['scripts/build-zyn.sh', 'scripts/build-zyn-windows.sh']) {
  const source = read(build);
  assert.match(source, /bot-runtime\/" "\$RESOURCES\/bot\//);
}

const optionalUpstream = '/private/tmp/hope-v1.6.78/app/resources/bot/target-register.mjs';
if (fs.existsSync(optionalUpstream)) {
  const actual = crypto.createHash('sha256').update(fs.readFileSync(optionalUpstream)).digest('hex');
  assert.equal(actual, manifest.upstreamFiles['resources/bot/target-register.mjs']);
}

console.log(JSON.stringify({
  ok: true,
  upstream: manifest.release,
  smsRemoved: true,
  proxyRequired: true,
  globalAccountWebhook: false,
  dedicatedSetting: true,
  liveAccountsUi: true,
}, null, 2));
