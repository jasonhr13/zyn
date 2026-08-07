#!/usr/bin/env node
'use strict';

// R6 keeps the recovered R5 engines as the source of truth. These narrow replacements only route
// OTP reads through the profile-owned mailbox API ported from jasonhr13/hope. Refuse unknown inputs
// so a future engine update cannot be silently rewritten with stale assumptions.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const helperDirectory = path.resolve(process.argv[2] || '');
if (!helperDirectory || !fs.existsSync(helperDirectory)) {
  console.error('Usage: patch-profile-imap-engines.js <public/helpers directory>');
  process.exit(2);
}

const SOURCES = Object.freeze({
  'target-engine.js': 'f43ff08d23fa8f4db55f8b1d2f12b76017f671eb5c33a785dc7110c9a075426d',
  'walmart-engine.js': '2fe7f711b28f97317ca5de6940f045c8255b0ada383e32d991274c388672429e',
});

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function openSource(filename) {
  const file = path.join(helperDirectory, filename);
  const raw = fs.readFileSync(file);
  const actual = sha256(raw);
  if (actual !== SOURCES[filename]) {
    throw new Error(`${filename} source hash ${actual} does not match the reviewed R5 source ${SOURCES[filename]}`);
  }
  return { file, newline: raw.includes(Buffer.from('\r\n')) ? '\r\n' : '\n', source: raw.toString('utf8').replace(/\r\n/g, '\n') };
}

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first === -1) throw new Error(`Could not find ${label}`);
  if (source.indexOf(before, first + before.length) !== -1) throw new Error(`Found ${label} more than once`);
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function saveSource(opened) {
  const output = opened.newline === '\r\n' ? opened.source.replace(/\n/g, '\r\n') : opened.source;
  fs.writeFileSync(opened.file, output, 'utf8');
}

function patchTarget() {
  const opened = openSource('target-engine.js');
  let source = opened.source;

  source = replaceOnce(source, `// IMAP config for OTP login. Prefer the top-level Settings → Email / OTP fields, but fall back to the
// Generate tab's config (settings.generate.*) so an existing email-auth-code setup works for Target
// with no re-entry. Generate's host can be a preset (imapHost) or a custom value (imapHostCustom).
function getImapConfig() {
  let s = {};
  try { s = dm.getSettings() || {}; } catch {}
  const g = s.generate || {};
  return {
    host: (s.imapHost || g.imapHostCustom || g.imapHost || '').trim(),
    user: (s.imapUser || g.imapUser || '').trim(),
    password: s.imapPass || g.imapPass || '',
    port: Number(s.imapPort || g.imapPort || 993) || 993,
  };
}`, `// IMAP belongs to the profile selected for this task. request-code normally carries taskID; email
// matching remains a fallback for older engine messages that only identify the account address.
function getImapConfig(profileId, email) {
  try { return dm.getProfileImap(profileId, email); }
  catch { return { host: '', port: 993, user: '', password: '' }; }
}`, 'Target global IMAP resolver');

  source = replaceOnce(source, `function otpEnabled() {
  if (getAycdKey()) return true;
  const c = getImapConfig();
  return !!(c.host && c.user && c.password);
}`, `function otpEnabled(profileId, email) {
  if (getAycdKey()) return true;
  const c = getImapConfig(profileId, email);
  return !!(c.host && c.user && c.password);
}`, 'Target OTP availability resolver');

  source = replaceOnce(source, 'const taskAccountById = new Map();', `const taskAccountById = new Map();
// taskId -> profileId, retained for request-code messages that arrive after startTarget returned.
const taskProfileById = new Map();`, 'Target task/profile map declaration');

  source = replaceOnce(source, `  const addr = String(email || '').trim();
  if (!addr) return;
  const key = addr.toLowerCase();`, `  const addr = String(email || '').trim();
  if (!addr) return;
  const profileId = taskProfileById.get(taskId) || '';
  const c = getImapConfig(profileId, addr);
  const key = addr.toLowerCase();`, 'Target task mailbox lookup');

  source = replaceOnce(source, `          log('[otp] AYCD returned no code' + (otpEnabled() && getImapConfig().host ? ' — trying IMAP' : ''));`, `          log('[otp] AYCD returned no code' + (otpEnabled(profileId, addr) && c.host ? ' — trying IMAP' : ''));`, 'Target AYCD empty fallback');
  source = replaceOnce(source, `      } catch (e) { log('[otp] AYCD failed: ' + ((e && e.message) || e) + (getImapConfig().host ? ' — falling back to IMAP' : '')); }`, `      } catch (e) { log('[otp] AYCD failed: ' + ((e && e.message) || e) + (c.host ? ' — falling back to IMAP' : '')); }`, 'Target AYCD error fallback');
  source = replaceOnce(source, `    const c = getImapConfig();
    if (!c.host || !c.user || !c.password) { if (!aycdKey) log('[otp] no OTP source configured — set an AYCD key or IMAP mailbox in Settings → Email / OTP'); return; }`, `    if (!c.host || !c.user || !c.password) { if (!aycdKey) log('[otp] no OTP source configured — add an AYCD key or configure the selected profile mailbox'); return; }`, 'Target profile mailbox requirement');
  source = replaceOnce(source, `    log('[otp] fetching Target login code via IMAP for ' + addr + ' — polling mailbox ' + c.user + ' …');`, `    log('[otp] fetching Target login code via IMAP for ' + addr + ' — polling profile mailbox ' + c.user + ' …');`, 'Target mailbox log');

  source = replaceOnce(source, `  let hasSession = false;
  try {
    const creds = config.accountId ? dm.getAccountCreds(config.accountId) : null;
    if (creds) {
      env.SHAPE_ACCT_EMAIL = creds.email || '';
      env.SHAPE_ACCT_PASS = creds.password || '';
      hasSession = !!creds.cookie;
    }
  } catch {}`, `  let hasSession = false;
  let accountEmail = '';
  try {
    const creds = config.accountId ? dm.getAccountCreds(config.accountId) : null;
    if (creds) {
      accountEmail = creds.email || '';
      env.SHAPE_ACCT_EMAIL = accountEmail;
      env.SHAPE_ACCT_PASS = creds.password || '';
      hasSession = !!creds.cookie;
    }
  } catch {}`, 'Target farmer account email');
  source = replaceOnce(source, `  const loginMode = otpEnabled() ? 'otp' : 'password';`, `  const loginMode = otpEnabled(config.profileId, accountEmail) ? 'otp' : 'password';`, 'Target farmer login mode');
  source = replaceOnce(source, `    useOtpLogin: otpEnabled(), startSchedule: '', stopSchedule: '', ignoreLowStock: false,`, `    useOtpLogin: otpEnabled(t.profileId), startSchedule: '', stopSchedule: '', ignoreLowStock: false,`, 'Target task OTP mode');

  source = replaceOnce(source, `      runningTaskIds.delete(t.id);
      status('Limit Reached'`, `      runningTaskIds.delete(t.id);
      taskProfileById.delete(t.id);
      status('Limit Reached'`, 'Target capped task cleanup');
  source = replaceOnce(source, `      runningTaskIds.clear();
      toRenderer('targetDone'`, `      runningTaskIds.clear();
      taskProfileById.clear();
      toRenderer('targetDone'`, 'Target exit task cleanup');
  source = replaceOnce(source, `    runningTaskIds.add(t.id);
    taskAccountById.set(t.id, t.accountId || '');`, `    runningTaskIds.add(t.id);
    taskAccountById.set(t.id, t.accountId || '');
    taskProfileById.set(t.id, t.profileId || '');`, 'Target task/profile association');
  source = replaceOnce(source, `      accountId: first.accountId || '',
      sku:`, `      accountId: first.accountId || '',
      profileId: first.profileId || '',
      sku:`, 'Target farmer profile association');
  source = replaceOnce(source, `    runningTaskIds.delete(taskId);
    toRenderer('targetDone'`, `    runningTaskIds.delete(taskId);
    taskProfileById.delete(taskId);
    toRenderer('targetDone'`, 'Target stopped task cleanup');
  source = replaceOnce(source, `  runningTaskIds.clear();
  toRenderer('targetDone'`, `  runningTaskIds.clear();
  taskProfileById.clear();
  toRenderer('targetDone'`, 'Target full task cleanup');

  opened.source = source;
  saveSource(opened);
}

function patchWalmart() {
  const opened = openSource('walmart-engine.js');
  let source = opened.source;

  source = replaceOnce(source, `// WaitForCode until we send \`received-code {email, code}\`. We fetch the code from the catch-all
// IMAP mailbox (Settings → Email / OTP) using the same proven client the register bots use.`, `// WaitForCode until we send \`received-code {email, code}\`. We fetch from the mailbox stored on the
// profile selected for this Walmart task, so two accounts can poll different inboxes concurrently.`, 'Walmart mailbox ownership comment');
  source = replaceOnce(source, `const otpInFlight = new Set();   // emails we're already fetching, so a repeated request-code is a no-op`, `const otpInFlight = new Set();   // emails we're already fetching, so a repeated request-code is a no-op
let activeConfig = null;`, 'Walmart active profile state');
  source = replaceOnce(source, `  try {
    let s = {};
    try { s = dm.getSettings() || {}; } catch {}
    if (!s.imapHost || !s.imapUser || !s.imapPass) {
      log('[otp] no IMAP mailbox configured — set it in Settings → Email / OTP to auto-solve the login code.');
      return;
    }`, `  try {
    const c = dm.getProfileImap(activeConfig && activeConfig.profileId, addr);
    if (!c.host || !c.user || !c.password) {
      log('[otp] no IMAP mailbox configured on the selected profile — edit that profile to auto-solve login codes.');
      return;
    }`, 'Walmart task mailbox lookup');
  source = replaceOnce(source, `    log('[otp] fetching Walmart login code for ' + addr + ' …');
    const { fetchAuthCode } = await import(pathToFileURL(script).href);
    const imapConfig = { host: s.imapHost, port: Number(s.imapPort) || 993, user: s.imapUser, password: s.imapPass };`, `    log('[otp] fetching Walmart login code for ' + addr + ' from profile mailbox ' + c.user + ' …');
    const { fetchAuthCode } = await import(pathToFileURL(script).href);
    const imapConfig = { host: c.host, port: Number(c.port) || 993, user: c.user, password: c.password };`, 'Walmart profile mailbox client');
  source = replaceOnce(source, `    useOtpLogin: false, startSchedule: '', stopSchedule: '', ignoreLowStock: false,`, `    useOtpLogin: (() => {
      const c = dm.getProfileImap(config.profileId, '');
      return !!(c.host && c.user && c.password);
    })(), startSchedule: '', stopSchedule: '', ignoreLowStock: false,`, 'Walmart task OTP mode');
  source = replaceOnce(source, `function startWalmart(config, mainWindow) {
  win = mainWindow;`, `function startWalmart(config, mainWindow) {
  win = mainWindow;
  activeConfig = config;`, 'Walmart active profile assignment');
  source = replaceOnce(source, `  engineProc = null;
  toRenderer('walmartDone'`, `  engineProc = null;
  activeConfig = null;
  toRenderer('walmartDone'`, 'Walmart active profile cleanup');

  opened.source = source;
  saveSource(opened);
}

try {
  patchTarget();
  patchWalmart();
  console.log(`Patched profile-owned IMAP routing in ${helperDirectory}`);
} catch (error) {
  console.error(`Profile IMAP engine patch failed: ${error.message}`);
  process.exit(1);
}
