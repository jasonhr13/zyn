#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const web = path.join(root, 'zyn-web');
require(path.join(web, 'server/node-path'));
const { createDataStore, FILES } = require(path.join(web, 'server/data-store'));
const { encryptSecret, decryptSecret, decodeCookie, accountCreds } = require(path.join(web, 'server/secrets'));
const { targetStartMessages, pokemonStartMessages, sendConfigsPayload, parseProxyLine } = require(path.join(web, 'server/configs'));
const { createCookieBank, applyDemand } = require(path.join(web, 'server/cookie-bank'));
const { createHttpServer, webEngineDemand, authorize } = require(path.join(web, 'server/http'));
const { createWebSessions } = require(path.join(web, 'server/sessions'));
const { fileSafeStorage } = require(path.join(web, 'server/license-host'));
const workspace = require(path.join(web, 'server/workspace'));
const { createBackupHost } = require(path.join(web, 'server/backup-host'));
const { createOtpHost, stageImapClient } = require(path.join(web, 'server/otp-host'));
const { remainingHarvestTargets } = require(path.join(root, 'launcher/harvest-room-demand'));
const loginHelper = require(path.join(root, 'runtime-app/public/helpers/target-login-harvester.js'));

const build = fs.readFileSync(path.join(root, 'scripts/build-native-target-engine.sh'), 'utf8');
assert.match(build, /linux-x64/, 'desktop engine builder must grow a linux-x64 target');
assert.match(build, /go_os="linux"/, 'linux engine must cross-compile with GOOS=linux');
assert.doesNotMatch(build, /build_arch linux/, 'linux must not join the desktop all set');

const dockerfile = fs.readFileSync(path.join(web, 'Dockerfile'), 'utf8');
assert.match(dockerfile, /native-backend\/linux-x64\/backend/);
assert.match(fs.readFileSync(path.join(web, 'fly.toml'), 'utf8'), /zyn_data/);
const readme = fs.readFileSync(path.join(web, 'README.md'), 'utf8');
assert.match(readme, /harvest-only/);
assert.match(readme, /login cookies/);
assert.match(readme, /same Zyn account email and password/);
assert.match(readme, /encrypted backup restore/);
assert.match(fs.readFileSync(path.join(web, 'server/public/index.html'), 'utf8'), /data-tab="backup"/);
assert.match(fs.readFileSync(path.join(web, 'server/index.js'), 'utf8'), /createBackupHost/);
assert.match(fs.readFileSync(path.join(web, 'Dockerfile'), 'utf8'), /NODE_PATH=\/app\/zyn-web\/node_modules/);
assert.match(fs.readFileSync(path.join(web, 'Dockerfile'), 'utf8'), /ca-certificates/);
assert.match(fs.readFileSync(path.join(web, 'Dockerfile'), 'utf8'), /SSL_CERT_FILE=\/etc\/ssl\/certs\/ca-certificates\.crt/);
assert.match(fs.readFileSync(path.join(web, 'server/engine-host.js'), 'utf8'), /SSL_CERT_FILE/);
assert.match(fs.readFileSync(path.join(web, 'Dockerfile'), 'utf8'), /native-farmer\/imap-client\.mjs/);
assert.match(fs.readFileSync(path.join(web, 'Dockerfile'), 'utf8'), /\/app\/zyn-web\/server\/imap-client\.mjs/);
assert.match(fs.readFileSync(path.join(web, 'Dockerfile'), 'utf8'), /ln -sfn \/app\/zyn-web\/node_modules \/app\/node_modules/);
assert.match(fs.readFileSync(path.join(web, 'package.json'), 'utf8'), /imapflow/);
assert.match(fs.readFileSync(path.join(web, 'server/public/index.html'), 'utf8'), /Sign in to ZynAIO/);
assert.match(fs.readFileSync(path.join(web, 'server/public/app.js'), 'utf8'), /credentials: 'include'/);
assert.match(fs.readFileSync(path.join(web, 'server/public/app.js'), 'utf8'), /\/api\/auth\/login/);
assert.match(fs.readFileSync(path.join(web, 'server/index.js'), 'utf8'), /createLicenseHost/);
assert.match(fs.readFileSync(path.join(web, 'server/index.js'), 'utf8'), /createHarvestHost/);
require(path.join(web, 'server/harvest-host'));
assert.match(fs.readFileSync(path.join(web, 'server/harvest-host.js'), 'utf8'), /hostRemote/);
assert.match(fs.readFileSync(path.join(web, 'server/harvest-host.js'), 'utf8'), /bank\.saveCookie/);
assert.match(fs.readFileSync(path.join(web, 'server/http.js'), 'utf8'), /loginNeedIds/);
assert.match(fs.readFileSync(path.join(web, 'server/public/electron-shim.js'), 'utf8'), /window\.require/);
assert.match(fs.readFileSync(path.join(web, 'Dockerfile'), 'utf8'), /frontend\/build/);
assert.equal(loginHelper.loginHarvesterShouldRun({ authorized: true, remoteLoginDemand: 1 }), true);
assert.equal(loginHelper.loginHarvesterShouldRun({ authorized: false, remoteLoginDemand: 1 }), false);

const idleDemand = webEngineDemand(0, 3, 0);
assert.equal(idleDemand.targets.login, 0, 'idle Full Engine must not ask remotes for login cookies');
assert.equal(idleDemand.targets.atc, 0);
assert.equal(idleDemand.loginTasks, 0);
const liveDemand = webEngineDemand(4, 3, 2);
assert.equal(liveDemand.targets.login, 2);
assert.equal(liveDemand.targets.atc, 12);
assert.equal(webEngineDemand(1, 3, 0).targets.login, 2, 'live checkout must prewarm login cookies');
assert.equal(webEngineDemand(1, 3, 5).targets.login, 5);
assert.deepEqual(applyDemand(idleDemand).targets, { login: 0, atc: 0 });
assert.deepEqual(remainingHarvestTargets({
  current: { login: 0, atc: 0 },
  targets: idleDemand.targets,
}), { login: 0, atc: 0 });
assert.deepEqual(remainingHarvestTargets({
  current: { login: 0, atc: 0 },
  targets: liveDemand.targets,
}), { login: 2, atc: 12 });
assert.deepEqual(remainingHarvestTargets({
  current: { login: 0, atc: 0 },
  waiting: { login: 1, atc: 0 },
  targets: { login: 0, atc: 0 },
}), { login: 1, atc: 0 }, 'engine waiters must keep login remaining open');
assert.equal(decodeCookie('enc:qq'), '');
assert.equal(decodeCookie(`b64:${Buffer.from('session', 'utf8').toString('base64')}`), 'session');
assert.match(fs.readFileSync(path.join(web, 'server/http.js'), 'utf8'), /no harvest-only Mac in the room/);
assert.match(fs.readFileSync(path.join(web, 'server/http.js'), 'utf8'), /harvest:/);

const safe = fileSafeStorage();
assert.equal(safe.isEncryptionAvailable(), true);
assert.equal(safe.decryptString(safe.encryptString('license-token')), 'license-token');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zyn-web-'));
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
const store = createDataStore(dir);
const sessions = createWebSessions(store);
const sessionToken = sessions.create();
assert.equal(sessions.check(sessionToken), true);
assert.equal(sessions.check('nope'), false);

store.saveProfiles([{ id: 'p1', email: 'a@b.c', profileType: 'target', shipping: { firstName: 'A', lastName: 'B' }, payment: { cardNumber: '4111', cardMonth: '12', cardYear: '2027', cardCvv: '123' } }]);
store.saveAccounts([{ id: 'a1', email: 'a@b.c', password: encryptSecret('secret'), cookie: 'session' }]);
store.saveProxies({ lists: [{ name: 'Resi', raw: '1.2.3.4:1000:user:pass\n' }] });
store.taskGroups.save([{
  name: 'Drop',
  items: [{ sku: '1012055696' }],
  qty: 2,
  proxyListName: 'Resi',
  tasks: [{ accountId: 'a1', profileId: 'p1', proxyListName: 'Resi' }],
}]);

assert.equal(decryptSecret(encryptSecret('secret')), 'secret');
assert.equal(accountCreds(store.getAccountsRaw()[0]).password, 'secret');
assert.throws(() => decryptSecret('enc:qq'), /safeStorage/);

const groups = store.taskGroups.load();
assert.equal(groups.length, 1);
assert.equal(fs.existsSync(path.join(dir, FILES.taskGroups)), true);
const starts = targetStartMessages(groups[0]);
assert.equal(starts[0].site, 'Target');
assert.deepEqual(parseProxyLine('1.2.3.4:1000:user:p:ass'), {
  address: '1.2.3.4', port: '1000', username: 'user', password: 'p:ass',
});
assert.equal(parseProxyLine('user:secret@5.6.7.8:8000').address, '5.6.7.8');
assert.match(fs.readFileSync(path.join(web, 'server/http.js'), 'utf8'), /set-task-proxy/);
assert.match(fs.readFileSync(path.join(web, 'server/http.js'), 'utf8'), /Stopped/);
assert.match(fs.readFileSync(path.join(web, 'server/http.js'), 'utf8'), /running\.monitors/);
assert.match(fs.readFileSync(path.join(web, 'server/http.js'), 'utf8'), /stopTargetMonitors/);
assert.doesNotMatch(fs.readFileSync(path.join(web, 'server/http.js'), 'utf8'), /zyn-web-\$\{Date\.now\(\)\}/);
assert.equal(starts[0].accountId, 'a1');
assert.equal(starts[0].item[0].monitorInput, '1012055696');

store.savePokemonCenterTasks({
  products: [{ input: 'https://www.pokemoncenter.com/product/x', quantity: '1' }],
  tasks: [{ id: 'pc1', profileId: 'p1' }],
});
const pokemon = pokemonStartMessages(store.getPokemonCenterTasks());
assert.equal(pokemon[0].site, 'Pokemon Center US');
assert.equal(pokemon[0].item.length, 1);

const configs = sendConfigsPayload(store, groups[0].tasks);
const profiles = JSON.parse(configs.profileList);
const accounts = JSON.parse(configs.accountList);
const proxies = JSON.parse(configs.proxyList);
assert.equal(profiles.p1.email, 'a@b.c');
assert.equal(accounts.a1.password, 'secret');
assert.equal(accounts.a1.cookie, 'session');
store.saveAccounts([{ id: 'a1', email: 'a@b.c', password: encryptSecret('secret'), cookie: 'enc:dead' }]);
assert.equal(accountCreds(store.getAccountsRaw()[0]).cookie, '');
assert.equal(JSON.parse(sendConfigsPayload(store, groups[0].tasks).accountList).a1.cookie, '');
assert.equal(proxies.Resi[0].address, '1.2.3.4');
assert.match(configs.settings, /Harvester/);

const extraProfile = workspace.saveProfile(store, {
  profileName: 'Web',
  email: 'w@b.c',
  shipping: { firstName: 'W', lastName: 'X' },
  payment: { cardNumber: '4111111111111111' },
});
assert.ok(store.getProfiles().some(profile => profile.id === extraProfile.id));
assert.equal(workspace.addAccountsBulk(store, 'fresh@b.c:hunter2\n', 'target').added, 1);
workspace.saveProxyList(store, 'ISP', '9.9.9.9:80:a:b');
const built = workspace.saveGroup(store, {
  name: 'WebDrop',
  skus: '1012055696',
  proxyListName: 'ISP',
  tasksFromAccounts: true,
});
assert.ok(built.tasks.length >= 1, 'group should attach Target accounts to matching profiles');

const backupHost = createBackupHost({
  store,
  dataDirectory: dir,
  authority: {
    backupAccountId: () => '',
    listBackups: async () => ({ ok: true, backups: [] }),
    uploadBackup: async () => ({ ok: false }),
    downloadBackup: async () => ({ ok: false }),
    deleteBackup: async () => ({ ok: false }),
  },
});
const imported = backupHost.importPayload({
  mode: 'merge',
  bundle: {
    app: 'zyn',
    kind: 'settings-export',
    version: 1,
    exportedAt: Date.now(),
    profiles: [{ id: 'p-import', profileName: 'Imported', email: 'i@b.c', profileType: 'target' }],
    accounts: [{ id: 'a-import', email: 'i@b.c', password: 'plain', site: 'target' }],
    proxies: { lists: [{ name: 'Imported', raw: '8.8.8.8:80' }] },
    taskGroups: [{
      name: 'Imported group',
      site: 'target',
      skus: '1234567',
      tasks: [{ accountId: 'a-import', profileId: 'p-import' }],
    }],
  },
});
assert.equal(imported.profiles.added, 1);
assert.ok(store.getProfiles().some(profile => profile.id === 'p-import'));
assert.ok(store.getAccountsRaw().some(account => account.id === 'a-import' && String(account.password).startsWith('b64:')));
assert.ok(store.taskGroups.load().some(group => group.name === 'Imported group'));

workspace.saveProfile(store, {
  id: extraProfile.id,
  imap: { host: 'imap.gmail.com', user: 'w@b.c', password: 'app pass' },
});
const mailbox = workspace.getProfileImap(store, extraProfile.id, 'w@b.c');
assert.equal(mailbox.host, 'imap.gmail.com');
assert.equal(mailbox.password, 'app pass');
assert.equal(mailbox.encrypted, false);
workspace.saveProfile(store, {
  id: extraProfile.id,
  imap: { host: 'imap.gmail.com', user: 'w@b.c', password: 'enc:dead' },
});
assert.equal(workspace.getProfileImap(store, extraProfile.id, 'w@b.c').encrypted, true);
assert.equal(workspace.getProfileImap(store, extraProfile.id, 'w@b.c').password, '');
workspace.saveProfile(store, {
  id: extraProfile.id,
  imap: { host: 'imap.gmail.com', user: 'w@b.c', password: 'app pass' },
});
assert.match(store.getProfiles().find(profile => profile.id === extraProfile.id).imap.password, /^b64:/);

const bank = createCookieBank({ token: 'tok', port: 0 });
(async () => {
  const staged = stageImapClient(path.join(root, 'native-farmer/imap-client.mjs'));
  assert.equal(staged, path.join(web, 'server/imap-client.mjs'));
  const imapMod = await import(pathToFileURL(staged).href);
  assert.equal(typeof imapMod.fetchAuthCode, 'function');

  const otpSent = [];
  let sawCode;
  const codeDelivered = new Promise(resolve => { sawCode = resolve; });
  let pollingMessage = '';
  const otp = createOtpHost({
    store,
    engine: {
      send(message) {
        otpSent.push(message);
        if (message.type === 'received-code') sawCode();
        return true;
      },
    },
    fetchAuthCode: async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
      return { code: '123456' };
    },
  });
  otp.subscribe(snapshot => {
    const item = snapshot.pending && snapshot.pending[0];
    if (item && item.phase === 'polling') pollingMessage = item.message;
  });
  otp.handleRequest({ email: 'w@b.c', requestId: 'req-1', taskID: 'task-otp' });
  assert.equal(otpSent[0].type, 'code-watcher-ready');
  await codeDelivered;
  assert.match(pollingMessage, /Polling the profile IMAP mailbox for the code/);
  assert.equal(otpSent.some(message => message.type === 'received-code' && message.messages[0].code === '123456'), true);

  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zyn-web-otp-'));
  const emptyOtp = createOtpHost({
    store: createDataStore(emptyDir),
    engine: { send: () => true },
  });
  emptyOtp.handleRequest({ email: 'none@b.c' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(emptyOtp.snapshot().pending[0].phase, 'manual');

  const encryptedOtp = createOtpHost({
    store,
    engine: { send: () => true },
  });
  workspace.saveProfile(store, {
    id: extraProfile.id,
    email: 'enc@b.c',
    imap: { host: 'imap.gmail.com', user: 'enc@b.c', password: 'enc:dead' },
  });
  encryptedOtp.handleRequest({ email: 'enc@b.c', taskID: 'task-enc' });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(encryptedOtp.snapshot().pending[0].message, /desktop-encrypted/);

  const address = await bank.listen();
  assert.ok(bank.saveCookie('atc', { 'user-agent': 'Zyn' }, 'http://proxy'));
  const status = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: address.port, path: '/status' }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve(JSON.parse(body)));
    }).on('error', reject);
  });
  assert.equal(status.atc, 1);
  assert.ok(bank.saveCookie('login', { 'user-agent': 'Zyn-login' }, 'http://proxy'));
  await bank.close();

  const licenseState = { ok: false, reason: 'Sign in to continue.', email: '', sessionKind: 'engine' };
  const harvestCalls = [];
  const mockLicense = {
    status: () => licenseState,
    login: async ({ email, password }) => {
      if (email === 'a@b.c' && password === 'secret') {
        Object.assign(licenseState, { ok: true, email, reason: '', sessionKind: 'engine' });
        return { ...licenseState };
      }
      return { ...licenseState, reason: 'Unable to sign in.' };
    },
    logout: async () => {
      Object.assign(licenseState, { ok: false, email: '', reason: 'Signed out.', sessionKind: 'engine' });
      return { ...licenseState };
    },
  };
  const mockHarvest = {
    start: () => harvestCalls.push('start'),
    stop: () => harvestCalls.push('stop'),
    update: () => harvestCalls.push('update'),
    snapshot: () => ({ connected: false, companionCount: 0, extensionCount: 0, enabled: true }),
  };
  const mockEngine = {
    subscribe() {},
    connected: () => false,
    ready: async () => {},
    send: () => true,
  };
  const webSessions = createWebSessions(createDataStore(fs.mkdtempSync(path.join(os.tmpdir(), 'zyn-web-sess-'))));
  const { server } = createHttpServer({
    store,
    engine: mockEngine,
    bank: { snapshot: () => ({ login: 0, atc: 0, demand: applyDemand(idleDemand).demand }) },
    license: mockLicense,
    sessions: webSessions,
    harvest: mockHarvest,
    backup: {
      status: () => ({ available: true, hasKey: false, accountBound: true }),
      importPayload: body => ({ profiles: { added: body && body.bundle ? 1 : 0 } }),
    },
    otp: { snapshot: () => ({ pending: [] }), subscribe() {}, submit: () => true, handleRequest() {}, cancelAll() {} },
    onDemand: async () => {},
  });
  const httpAddress = await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address())));
  const origin = `http://127.0.0.1:${httpAddress.port}`;
  const request = (pathname, options = {}) => new Promise((resolve, reject) => {
    const req = http.request(origin + pathname, {
      method: options.method || 'GET',
      headers: options.headers || {},
    }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: body ? JSON.parse(body) : {},
      }));
    });
    req.on('error', reject);
    if (options.body) req.end(JSON.stringify(options.body));
    else req.end();
  });
  const page = await new Promise((resolve, reject) => {
    http.get(origin + '/', res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
  assert.equal(page.status, 200);
  assert.match(page.body, /electron-shim|Sign in to ZynAIO/);
  const blocked = await request('/api/state');
  assert.equal(blocked.status, 401);
  const session = await request('/api/auth/session');
  assert.equal(session.body.signedIn, false);
  const denied = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: { email: 'a@b.c', password: 'wrong' },
  });
  assert.equal(denied.status, 401);
  const signed = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: { email: 'a@b.c', password: 'secret' },
  });
  assert.equal(signed.body.ok, true);
  assert.equal(signed.body.email, 'a@b.c');
  assert.match(String(signed.headers['set-cookie'] || ''), /zyn_session=/);
  assert.ok(harvestCalls.includes('start'));
  assert.ok(harvestCalls.includes('update'));
  const cookie = String(signed.headers['set-cookie']).split(';')[0];
  const okState = await request('/api/state', { headers: { cookie } });
  assert.equal(okState.status, 200);
  assert.equal(okState.body.email, 'a@b.c');
  const created = await request('/api/profiles', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: { profileName: 'Http', email: 'h@b.c' },
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.profile.profileName, 'Http');
  const importedHttp = await request('/api/backup/import', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: { mode: 'merge', bundle: { app: 'zyn' } },
  });
  assert.equal(importedHttp.status, 200);
  assert.equal(authorize({
    headers: { cookie },
    url: '/api/state',
  }, { sessions: webSessions, license: mockLicense }), true);
  const signedSession = await request('/api/auth/session', { headers: { cookie } });
  assert.equal(signedSession.body.signedIn, true);
  const loggedOut = await request('/api/auth/logout', { method: 'POST', headers: { cookie } });
  assert.equal(loggedOut.status, 200);
  assert.ok(harvestCalls.includes('stop'));
  const afterLogout = await request('/api/state', { headers: { cookie } });
  assert.equal(afterLogout.status, 401);
  await new Promise(resolve => server.close(resolve));

  const check = spawnSync(process.execPath, ['--check', path.join(web, 'server/index.js')]);
  assert.equal(check.status, 0, String(check.stderr));
  console.log(JSON.stringify({
    ok: true,
    files: Object.values(FILES),
    linuxEngine: 'scripts/build-native-target-engine.sh linux-x64',
    fly: 'zyn-web/fly.toml',
    login: 'zyn email/password',
  }, null, 2));
})().catch(error => {
  console.error(error);
  process.exit(1);
});
