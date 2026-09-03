const { app, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const dataDir = app.getPath('userData');
const jsonCache = new Map();

function cloneDefault(value) {
  if (Array.isArray(value)) return value.slice();
  if (value && typeof value === 'object') return { ...value };
  return value;
}

function readJSON(filename, defaultVal) {
  if (jsonCache.has(filename)) return jsonCache.get(filename);
  const file = path.join(dataDir, filename);
  try {
    if (!fs.existsSync(file)) {
      const empty = cloneDefault(defaultVal);
      jsonCache.set(filename, empty);
      return empty;
    }
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    jsonCache.set(filename, parsed);
    return parsed;
  } catch {
    const empty = cloneDefault(defaultVal);
    jsonCache.set(filename, empty);
    return empty;
  }
}

function writeJSON(filename, data) {
  jsonCache.set(filename, data);
  fs.writeFileSync(path.join(dataDir, filename), JSON.stringify(data), 'utf8');
}

// ── Tasks ──────────────────────────────────────────────────────────────────────
function getTasks() { return readJSON('tasks.json', []); }

function createTask(data) {
  const tasks = getTasks();
  const task = { id: uuidv4(), ...data };
  tasks.push(task);
  writeJSON('tasks.json', tasks);
  return task;
}

function updateTask(id, data) {
  const tasks = getTasks().map(t => t.id === id ? { ...t, ...data } : t);
  writeJSON('tasks.json', tasks);
}

function deleteTask(id) {
  writeJSON('tasks.json', getTasks().filter(t => t.id !== id));
}

// ── Pokemon Center tasks ───────────────────────────────────────────────────────────────
function getPokemonCenterTasks() {
  return readJSON('pokemon-center-tasks.json', {
    products: [{ id: 'pc_product_1', input: '', quantity: '1' }], tasks: [], monitorDelay: '3000', retryDelay: '3000',
    loopCheckout: false, waitForQueue: false, queueEntryDelay: '0', allInstock: false, setupOpen: true,
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

function getWalmartTasks() {
  return readJSON('walmart-tasks.json', {
    products: [{ id: 'wm_product_1', input: '', quantity: '1', maxPrice: '' }], tasks: [],
    monitorDelay: '3000', retryDelay: '3000', endless: false, mode: 'Checkout', setupOpen: true,
  });
}

function saveWalmartTasks(data) {
  const current = getWalmartTasks();
  const next = {
    ...current,
    ...(data && typeof data === 'object' ? data : {}),
    products: Array.isArray(data && data.products) ? data.products : current.products,
    tasks: Array.isArray(data && data.tasks) ? data.tasks : current.tasks,
  };
  writeJSON('walmart-tasks.json', next);
  return next;
}

// ── Target tasks ───────────────────────────────────────────────────────────────
// Kept in their OWN file rather than sharing tasks.json: Secret Lair tasks carry a productUrl and
// profileIds, Target tasks carry an accountId and resolve their profile by email at launch. Mixing
// two shapes in one list means every reader has to guess which kind it is holding.
//
// The watched SKU list is stored ALONGSIDE the tasks because it is genuinely module-level, not
// per-task: one monitor watches every SKU and each task fires on whichever restocks first.
function getTargetTasks() { return readJSON('target-tasks.json', { skus: '', tasks: [] }); }

function saveTargetTasks(data) {
  const cur = getTargetTasks();
  const next = {
    skus: data && typeof data.skus === 'string' ? data.skus : cur.skus,
    tasks: Array.isArray(data && data.tasks) ? data.tasks : cur.tasks,
  };
  writeJSON('target-tasks.json', next);
  return next;
}

// ── Target order limits ────────────────────────────────────────────────────────
// "At most N orders of the same SKU per account within a rolling window." Target enforces its own
// purchase caps, but hitting them repeatedly is exactly the pattern that gets an account flagged,
// so we stop before Target has to. Keyed accountId|tcin -> [epoch ms, ...]; timestamps outside the
// window are dropped on read, so the file self-prunes instead of growing forever.
const ORDER_LIMIT_WINDOW_MS = 4 * 60 * 60 * 1000;   // 4 hours
const ORDER_LIMIT_MAX = 2;                          // orders per account per SKU in that window

function orderLimitKey(accountId, tcin) { return `${String(accountId || '')}|${String(tcin || '')}`; }

function getTargetOrderLog() { return readJSON('target-order-log.json', {}); }

function recentTargetOrders(accountId, tcin, now = Date.now()) {
  const all = getTargetOrderLog()[orderLimitKey(accountId, tcin)] || [];
  return all.filter(ts => now - ts < ORDER_LIMIT_WINDOW_MS);
}

// True when this account has already placed its allowance of this SKU inside the window.
function targetOrderLimitReached(accountId, tcin) {
  if (!accountId || !tcin) return false;
  return recentTargetOrders(accountId, tcin).length >= ORDER_LIMIT_MAX;
}

function recordTargetOrder(accountId, tcin, ts = Date.now()) {
  if (!accountId || !tcin) return;
  const log = getTargetOrderLog();
  const key = orderLimitKey(accountId, tcin);
  const kept = (log[key] || []).filter(t => ts - t < ORDER_LIMIT_WINDOW_MS);
  kept.push(ts);
  log[key] = kept;
  writeJSON('target-order-log.json', log);
}

// ── Profiles ───────────────────────────────────────────────────────────────────
function getProfiles() { return readJSON('profiles.json', []); }

function accountSiteOf(account) {
  return String((account && account.site) || '').trim().toLowerCase() || 'target';
}

function profileTypeOf(profile) {
  return String((profile && profile.profileType) || 'target').trim().toLowerCase() || 'target';
}

function profileTypeForAccountSite(site) {
  const tag = String(site || '').trim().toLowerCase();
  if (tag === 'walmart' || tag === 'pokemoncenter') return tag;
  return 'target';
}

function matchingProfileForAccount(profiles, email, site) {
  const want = String(email || '').trim().toLowerCase();
  if (!want || !Array.isArray(profiles)) return null;
  const type = profileTypeForAccountSite(site);
  const sameEmail = profiles.filter(profile => String(profile && profile.email || '').trim().toLowerCase() === want);
  return sameEmail.find(profile => profileTypeOf(profile) === type)
    || (type === 'walmart' ? sameEmail.find(profile => profileTypeOf(profile) === 'target') : null)
    || null;
}

function linkAccountsToProfile(profile) {
  const email = String((profile && profile.email) || '').trim().toLowerCase();
  const type = profileTypeOf(profile);
  if (!email || type === 'pokemoncenter') return;
  const accounts = getAccountsRaw();
  let changed = false;
  for (const account of accounts) {
    if (account.profileId) continue;
    if (String(account.email || '').trim().toLowerCase() !== email) continue;
    if (accountSiteOf(account) !== type) continue;
    account.profileId = profile.id;
    changed = true;
  }
  if (changed) writeJSON('accounts.json', accounts);
}

function createProfile(data) {
  const profiles = getProfiles();
  const profile = { id: uuidv4(), ...data };
  profiles.push(profile);
  writeJSON('profiles.json', profiles);
  linkAccountsToProfile(profile);
  return profile;
}

// Create many profiles in ONE write (used by "create a profile per account"). Any incoming id is
// stripped so each gets a fresh one — otherwise cloning a profile would collide every clone onto the
// source's id. Returns the created profiles.
function createProfilesBulk(list) {
  const profiles = getProfiles();
  const created = [];
  for (const raw of (Array.isArray(list) ? list : [])) {
    const { id, ...data } = raw || {};   // eslint-disable-line no-unused-vars -- strip incoming id
    const profile = { id: uuidv4(), ...data };
    profiles.push(profile);
    created.push(profile);
  }
  if (created.length) {
    writeJSON('profiles.json', profiles);
    created.forEach(linkAccountsToProfile);
  }
  return created;
}

function updateProfile(id, data) {
  const profiles = getProfiles().map(p => p.id === id ? { ...p, ...data } : p);
  writeJSON('profiles.json', profiles);
}

function deleteProfile(id) {
  writeJSON('profiles.json', getProfiles().filter(p => p.id !== id));
}

// ── Profile groups ───────────────────────────────────────────────────────────────
// User-defined tags on a profile (`groups: string[]`). Coupon Mode tags accounts that hold the
// free-shipping coupon into a "Coupon" group; the P-Bandai task picker can filter/select by group.
function getGroups() {
  const set = new Set();
  for (const p of getProfiles()) for (const g of (p.groups || [])) if (g) set.add(g);
  return [...set].sort((a, b) => a.localeCompare(b));
}

// Add `group` to each of `ids` (idempotent). Returns how many profiles were newly tagged.
function addProfilesToGroup(ids, group) {
  const g = String(group || '').trim();
  if (!g) return 0;
  const set = new Set((Array.isArray(ids) ? ids : [ids]).map(String));
  let n = 0;
  const profiles = getProfiles().map(p => {
    if (!set.has(String(p.id))) return p;
    const groups = Array.isArray(p.groups) ? p.groups : [];
    if (groups.includes(g)) return p;
    n++;
    return { ...p, groups: [...groups, g] };
  });
  if (n) writeJSON('profiles.json', profiles);
  return n;
}

function removeProfilesFromGroup(ids, group) {
  const g = String(group || '').trim();
  const set = new Set((Array.isArray(ids) ? ids : [ids]).map(String));
  writeJSON('profiles.json', getProfiles().map(p =>
    set.has(String(p.id)) && Array.isArray(p.groups) ? { ...p, groups: p.groups.filter(x => x !== g) } : p));
}

// Replace a profile's entire group list (Accounts-page manual edit).
function setProfileGroups(id, groups) {
  const clean = [...new Set((Array.isArray(groups) ? groups : []).map(x => String(x).trim()).filter(Boolean))];
  updateProfile(id, { groups: clean });
}

// ── Coupon-check results ───────────────────────────────────────────────────────
// profileId → 'has' | 'none', so a stopped/restarted Coupon Mode run skips accounts already checked.
// "could not sign in" (soft-block) is NOT recorded, so those retry on the next run.
function getCouponChecked() { return readJSON('coupon-checks.json', {}); }
function setCouponChecked(profileId, result) {
  const m = getCouponChecked();
  m[String(profileId)] = result;
  writeJSON('coupon-checks.json', m);
}
// ── Round1 signup profiles ─────────────────────────────────────────────────────
// Kept separate from checkout profiles on purpose. A Round1 entry needs a name, an email and a
// pickup store — no card, no address, no account credentials — and the browser extension already
// models it exactly that way. Sharing the shape means export/import between the two is a copy
// rather than a translation, which is the whole point of having it here.
function getRound1Profiles() { return readJSON('round1-profiles.json', []); }
function saveRound1Profiles(list) {
  const clean = (Array.isArray(list) ? list : []).map((p, i) => ({
    id: String(p.id || `r1_${Date.now()}_${i}`),
    first: String(p.first || '').trim(),
    last: String(p.last || '').trim(),
    email: String(p.email || '').trim(),
    store: String(p.store || '').trim(),
    marketing: !!p.marketing,
    // Set when a signup completes. Rebuilt fields only, so this has to be listed explicitly or the
    // very next save would drop the record of a registration that already happened. Undefined is
    // omitted by JSON.stringify, so an un-registered profile stays the same shape the extension uses.
    ...(p.registeredAt ? { registeredAt: p.registeredAt } : {}),
  })).filter((p) => p.first || p.last || p.email);
  writeJSON('round1-profiles.json', clean);
  return clean;
}
// Merge on EMAIL, not id: the extension mints its own ids, so importing the same person twice would
// otherwise create a duplicate that races itself for one entry against a capped campaign.
function importRound1Profiles(incoming, replace) {
  const arriving = Array.isArray(incoming) ? incoming : [];
  if (replace) return saveRound1Profiles(arriving);
  const existing = getRound1Profiles();
  const byEmail = new Map(existing.map((p) => [p.email.toLowerCase(), p]));
  let added = 0, updated = 0;
  for (const p of arriving) {
    const key = String(p.email || '').trim().toLowerCase();
    if (!key) continue;
    if (byEmail.has(key)) {
      // Update the details, keep the IDENTITY. The incoming id belongs to the other tool, and taking
      // the incoming email would rewrite the stored casing — importing "GRACE@x.com" over
      // "grace@x.com" then makes every lookup by the original address miss.
      const cur = byEmail.get(key);
      Object.assign(cur, { ...p, id: cur.id, email: cur.email });
      updated++;
    }
    else { byEmail.set(key, { ...p, id: String(p.id || `r1_${Date.now()}_${added}`) }); added++; }
  }
  const merged = saveRound1Profiles([...byEmail.values()]);
  return { profiles: merged, added, updated };
}

// onlyResult 'none' forgets just the confirmed no-coupon accounts, so a re-scan re-checks them without
// redoing the confirmed holders (P-Bandai issues coupons over time, so 'none' goes stale; 'has' doesn't).
// Omit it to forget everything. Returns how many records were removed.
function clearCouponChecked(onlyResult) {
  const m = getCouponChecked();
  if (!onlyResult) { const n = Object.keys(m).length; writeJSON('coupon-checks.json', {}); return n; }
  let n = 0;
  for (const k of Object.keys(m)) if (m[k] === onlyResult) { delete m[k]; n++; }
  writeJSON('coupon-checks.json', m);
  return n;
}
// { has, none } counts for the Coupon-Mode footer, so the operator can see what a re-scan would cover.
function couponCheckedStats() {
  const v = Object.values(getCouponChecked());
  return { has: v.filter(x => x === 'has').length, none: v.filter(x => x === 'none').length };
}

// ── Proxies ────────────────────────────────────────────────────────────────────
function getProxies() { return readJSON('proxies.json', { lists: [] }); }

function saveProxyList(name, raw) {
  const data = getProxies();
  const idx = data.lists.findIndex(l => l.name === name);
  if (idx >= 0) data.lists[idx] = { name, raw };
  else data.lists.push({ name, raw });
  writeJSON('proxies.json', data);
}

function deleteProxyList(name) {
  const data = getProxies();
  data.lists = data.lists.filter(l => l.name !== name);
  writeJSON('proxies.json', data);
}

function getProxyLines(listName) {
  const data = getProxies();
  const list = data.lists.find(l => l.name === listName);
  if (!list) return [];
  return list.raw.split('\n').map(l => l.trim()).filter(Boolean);
}

// ── Accounts (email:password, for auto-login) ───────────────────────────────────
// Passwords are encrypted at rest with Electron safeStorage (Windows DPAPI, scoped to this
// OS user), so accounts.json never holds a readable password. The renderer only ever gets
// `hasPassword` and `hasSession`; the plaintext password and session cookie stay in main.
function encryptSecret(plain) {
  const s = String(plain == null ? '' : plain);
  if (!s) return '';
  try {
    if (safeStorage && safeStorage.isEncryptionAvailable()) {
      return 'enc:' + safeStorage.encryptString(s).toString('base64');
    }
  } catch {}
  // OS keychain unavailable — this is only obfuscation, not encryption. Better than clear text.
  return 'b64:' + Buffer.from(s, 'utf8').toString('base64');
}

function decryptSecret(stored) {
  const s = String(stored == null ? '' : stored);
  try {
    if (s.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(s.slice(4), 'base64'));
    if (s.startsWith('b64:')) return Buffer.from(s.slice(4), 'base64').toString('utf8');
  } catch {}
  return '';
}

function getAccountsRaw() { return readJSON('accounts.json', []); }

// Renderer-safe view — password and session cookie never leave the main process.
function getAccounts() {
  return getAccountsRaw().map(({ password, cookie, ...rest }) => ({
    ...rest,
    hasPassword: !!password,
    hasSession: Boolean(String(cookie || '').trim()),
  }));
}

// Main-only. Decrypt at point of use. Includes the saved Target session cookie (if any) so the
// engine can skip the full OTP login and just refresh the session.
function getAccountCreds(id) {
  const a = getAccountsRaw().find(x => x.id === id);
  if (!a) return null;
  const password = decryptSecret(a.password);
  return password ? { email: a.email, password, cookie: a.cookie || '' } : null;
}

// Persist the Target session cookie the engine emits after a successful login, so future runs reuse
// the session instead of re-logging in (Target sessions last a long time).
function setAccountCookie(accountId, cookie) {
  const accounts = getAccountsRaw();
  const a = accounts.find(x => String(x.id) === String(accountId));
  if (!a) return false;
  a.cookie = String(cookie || '');
  writeJSON('accounts.json', accounts);
  return true;
}

// Which account a profile checks out as: an explicit link wins, else match on email.
//
// SITE MATTERS. One inbox legitimately holds a separate account on every retailer, and without a
// site this returned whichever row happened to sit first in the file — so a Bandai launch could be
// handed the TARGET account's password. It fails as a login rather than loudly, which is the worst
// way for it to be wrong.
//
// A blank site on an account means "added before site tagging", and this app's account list was
// Bandai-only then — same rule as siteOf() on the Accounts page, so those still serve Bandai.
// Callers that pass no site keep the old behaviour, which is what the credential-copy path wants:
// it is showing the operator a row, not choosing which retailer to log into.
function accountForProfile(profileId, site = '') {
  const prof = getProfiles().find(p => p.id === profileId);
  if (!prof) return null;
  const accounts = getAccountsRaw();
  const wanted = String(site || '').toLowerCase();
  const onSite = (a) => {
    if (!wanted) return true;
    const tag = String(a.site || '').toLowerCase();
    return tag === wanted || (!tag && wanted === 'bandai');
  };
  const email = (prof.email || '').toLowerCase();
  return accounts.find(a => a.profileId === profileId && onSite(a))
      || accounts.find(a => (a.email || '').toLowerCase() === email && onSite(a))
      || null;
}

// Bulk paste, one "email:password" per line. Re-pasting an email updates its password
// instead of duplicating the account. New accounts auto-link to a profile of the same email.
// `site` (added 2026-07-20, e.g. 'bandai'/'target'/'walmart'/'icloud'): tags NEW accounts with
// whichever site tab was active on the Accounts page when the user pasted — lets manually-added
// accounts land in the right group alongside ones the Generate tab created automatically. Existing
// accounts being updated (password refresh) keep their current site untouched.
function addAccountsBulk(raw, site = '') {
  const accounts = getAccountsRaw();
  const profiles = getProfiles();
  const now = Date.now();
  let added = 0, updated = 0, skipped = 0;
  for (const line of String(raw == null ? '' : raw).split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const i = t.indexOf(':');                       // split on FIRST colon — passwords may contain ':'
    const email = i > 0 ? t.slice(0, i).trim() : '';
    const pw    = i > 0 ? t.slice(i + 1).trim() : '';
    if (!email || !pw || !email.includes('@')) { skipped++; continue; }
    // Match on email AND site — the same rule addGeneratedAccount already uses.
    //
    // Matching on email alone MOVED the account instead of adding one: pasting
    // test@gmail.com under Walmart and then under Pokémon Center found the Walmart row, re-tagged
    // it 'pokemoncenter', and the account vanished from the Walmart tab. One inbox legitimately
    // holds a separate account on every retailer, which is the whole reason the site field exists.
    //
    // On the "All" tab site is '' — there is no site to disambiguate by, so fall back to matching
    // on email and refresh the password without re-tagging whatever site it already had.
    const wantEmail = email.toLowerCase();
    const existing = accounts.find(a =>
      (a.email || '').toLowerCase() === wantEmail && (site ? (a.site || '') === site : true));
    if (existing) { existing.password = encryptSecret(pw); updated++; continue; }
    const match = matchingProfileForAccount(profiles, email, site);
    accounts.push({ id: uuidv4(), email, password: encryptSecret(pw), profileId: match ? match.id : null, createdAt: now, source: 'manual', site });
    added++;
  }
  writeJSON('accounts.json', accounts);
  return { added, updated, skipped, total: accounts.length };
}

// Single-account upsert used by the Generate tab right after a bot successfully creates an
// account — tagged source:'generated' so the Accounts page can show "Genned at" instead of
// "Added at". Re-generating the same email updates its password but keeps the original createdAt.
//
// `site` (added 2026-07-20, e.g. 'bandai'/'target'/'walmart'): which module actually created this
// account. Needed so the Generate tab can skip re-generating an email that already has an account
// on THAT site without also skipping it for a DIFFERENT site — accounts.json has no other way to
// tell "already has a Bandai account" apart from "already has a Target account" for the same email
// (they're genuinely different site accounts that happen to share an inbox). Optional and defaults
// to '' for callers that don't pass it (e.g. addAccountsBulk's manual paste, which has no site
// concept at all) — see generate.js's dedup logic for how a blank/missing site is treated.
function addGeneratedAccount({ email, password, site = '' }) {
  const accounts = getAccountsRaw();
  const wanted = (email || '').toLowerCase();

  // Match on email AND site. Matching on email alone was the bug behind "the new account never
  // shows up under iCloud": iCloud aliases are the very addresses the Bandai generator registers
  // with, so by the time you generate/scrape aliases the row already exists tagged site 'bandai'.
  // The old code found that row, kept its original site (`site = site || site` never overwrites),
  // and returned — so nothing was ever added under 'icloud'. Same email on two sites is legitimate
  // and is exactly what the site field exists to express.
  //
  // A blank site (manual bulk paste, which has no site concept) still matches on email alone so
  // pasting a known address keeps updating its existing row rather than creating an untagged twin.
  const existing = accounts.find(a =>
    (a.email || '').toLowerCase() === wanted && (!site || (a.site || '') === site));

  if (existing) {
    // Only overwrite a stored password with a real one. iCloud aliases are saved with password ''
    // (an alias is an inbox, not a login), and blindly encrypting that wiped the REAL password off
    // a Bandai/Target account sharing the address — silent credential loss on an account that then
    // fails to log in.
    if (password) existing.password = encryptSecret(password);
    existing.source = existing.source || 'generated';
    existing.site = existing.site || site;
    existing.createdAt = existing.createdAt || Date.now();
    writeJSON('accounts.json', accounts);
    return existing;
  }
  const profiles = getProfiles();
  const match = matchingProfileForAccount(profiles, email, site);
  const acct = { id: uuidv4(), email, password: encryptSecret(password), profileId: match ? match.id : null, createdAt: Date.now(), source: 'generated', site };
  accounts.push(acct);
  writeJSON('accounts.json', accounts);
  return acct;
}

function updateAccount(id, data) {
  const accounts = getAccountsRaw().map(a => {
    if (a.id !== id) return a;
    const next = { ...a, ...data };
    if (data.password !== undefined) next.password = encryptSecret(data.password);
    return next;
  });
  writeJSON('accounts.json', accounts);
}

function deleteAccount(id) {
  writeJSON('accounts.json', getAccountsRaw().filter(a => a.id !== id));
}

// ── Watchlist (single persisted P-Bandai monitor SKU list) ──────────────────────
function getWatchlist() { return readJSON('watchlist.json', { raw: '' }).raw || ''; }
function saveWatchlist(raw) { writeJSON('watchlist.json', { raw: String(raw == null ? '' : raw) }); }

// ── Last placed order per profile (epoch ms) ─────────────────────────────────────
// Persisted so "Last placed order: <time>" survives restarts and shows for profiles that aren't
// currently running. Keyed by profileId.
function getLastOrders() { return readJSON('last-orders.json', {}); }
function setLastOrder(profileId, ts) {
  const m = getLastOrders();
  m[String(profileId)] = ts;
  writeJSON('last-orders.json', m);
  return m;
}

// ── Last CARTED per profile (epoch ms) ───────────────────────────────────────────
// "This account had the item in its cart." Persisted so a restart mid-drop can put those accounts
// first — they're the ones closest to a completed order. Entries older than CARTED_TTL_MS are
// ignored by readers: a cart from days ago says nothing about today's drop.
const CARTED_TTL_MS = 24 * 60 * 60 * 1000;
function getLastCarted() { return readJSON('last-carted.json', {}); }
function setLastCarted(profileId, ts) {
  const m = getLastCarted();
  m[String(profileId)] = ts;
  writeJSON('last-carted.json', m);
  return m;
}
// profileIds that carted within the TTL AND haven't completed an order since — the "priority tier"
// for launch ordering. Excluding accounts that carted-THEN-bought is the whole point: an account that
// already placed its order is DONE (and re-running it just hits the per-customer max-qty limit and
// wastes a rotate slot). Only carted-but-didn't-finish accounts are genuine mid-drop recovery cases.
function recentlyCartedIds(ttl = CARTED_TTL_MS) {
  const carted = getLastCarted();
  const orders = getLastOrders();
  const cut = Date.now() - ttl;
  return Object.keys(carted).filter(k =>
    Number(carted[k]) >= cut &&                        // carted recently, AND
    Number(orders[k] || 0) < Number(carted[k]));        // no order placed at/after that cart
}

// ── Settings ───────────────────────────────────────────────────────────────────
function getSettings() {
  const defaults = {
    botScriptDir: 'C:\\Users\\xmeow\\OneDrive\\Desktop\\aco-website\\helpmecheckout\\scripts',
    // Never hardcode a bot token here — it would ship to anyone the bot is shared with.
    // Each user sets it in Settings; it's stored in userData settings.json (outside the repo).
    discordBotToken: process.env.ZYN_DISCORD_TOKEN || '',
    discordChannelId: '1352200333648068648',
    discordWebhook: '',
    discordDeclineWebhook: '',
    accountGenWebhook: '',
    defaultQty: 1,
    defaultProductUrl: '',
    // Antibot solver keys (Walmart PerimeterX). Never hardcode a real key — each user pastes
    // their own in Settings; stored in userData settings.json, pushed to the engine at task start.
    lucaApiKey: '',
    hyperApiKey: '',
    // Catch-all mailbox for automated email-OTP login (Walmart account 2FA). One IMAP inbox that
    // receives every account alias's mail; the engine's per-account email is used as the To: filter.
    imapHost: '',
    imapPort: 993,
    imapUser: '',
    imapPass: '',
    resiFactoryApiKey: '',
    evomiApiKey: '',
    ipfistApiKey: '',
    hcaptchaAutosolve: true,
  };
  // Merge so new default fields always appear even if settings.json predates them
  return { ...defaults, ...readJSON('settings.json', {}) };
}

function saveSettings(settings) { writeJSON('settings.json', settings); }

// ── Export / Import (backup & migrate) ───────────────────────────────────────────
// PLAINTEXT bundle, by the user's explicit choice. Passwords are DECRYPTED into the file so it can
// move to another machine or OS user (safeStorage/DPAPI blobs are user+machine scoped and would not
// decrypt after a move). The trade-off: the file holds card details, site passwords, and the Discord
// token in the clear — the UI warns before it's written. Import re-encrypts passwords with THIS
// machine's safeStorage. `settings` is the raw user-set object (not the merged defaults) so importing
// never bakes in this machine's hardcoded default paths.
// Credentials that belong to the OPERATOR, not to the data being moved. A backup is routinely
// handed to someone else (to seed their profiles/proxies, or to move machines), and shipping these
// inside it silently gives that person your Discord bot and your paid solver accounts. Stripped on
// export; importAll merges keys, so an existing local value is simply left alone.
const EXPORT_REDACTED = ['discordBotToken', 'licenseKey', 'aycdApiKey', 'lucaApiKey', 'hyperApiKey', 'imapPass', 'resiFactoryApiKey', 'evomiApiKey', 'ipfistApiKey'];

function exportAll() {
  const settings = { ...readJSON('settings.json', {}) };
  for (const k of EXPORT_REDACTED) delete settings[k];
  if (settings.imapByHost) {
    settings.imapByHost = Object.fromEntries(
      Object.entries(settings.imapByHost).map(([host, v]) => [host, { ...v, pass: '' }]));
  }
  return {
    app: 'zyn',
    kind: 'settings-export',
    version: 1,
    exportedAt: Date.now(),
    profiles: getProfiles(),
    accounts: getAccountsRaw().map(({ password, ...rest }) => ({ ...rest, password: decryptSecret(password) })),
    proxies: getProxies(),
    settings,
    lastOrders: getLastOrders(),
  };
}

// Merge (default) NEVER deletes: profiles add by unseen id, accounts by unseen email, proxy lists and
// settings keys are overlaid, lastOrders keep the newer timestamp. Replace overwrites each present
// section wholesale. Returns a per-section count summary.
function importAll(bundle, mode = 'merge') {
  const legacyApp = ['secret', 'lair', 'bot'].join('-');
  if (!bundle || (bundle.app !== 'zyn' && bundle.app !== legacyApp)) throw new Error('Not a Zyn export file.');
  const replace = mode === 'replace';
  const summary = {};

  if (Array.isArray(bundle.profiles)) {
    if (replace) { writeJSON('profiles.json', bundle.profiles); summary.profiles = { set: bundle.profiles.length }; }
    else {
      const cur = getProfiles();
      const have = new Set(cur.map(p => p.id));
      let added = 0;
      for (const p of bundle.profiles) { if (p && p.id && !have.has(p.id)) { cur.push(p); have.add(p.id); added++; } }
      writeJSON('profiles.json', cur); summary.profiles = { added };
    }
  }

  if (Array.isArray(bundle.accounts)) {
    const enc = a => ({ ...a, password: a.password ? encryptSecret(a.password) : '' });
    if (replace) { writeJSON('accounts.json', bundle.accounts.map(enc)); summary.accounts = { set: bundle.accounts.length }; }
    else {
      const cur = getAccountsRaw();
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
      writeJSON('accounts.json', cur); summary.accounts = { added };
    }
  }

  if (bundle.proxies && Array.isArray(bundle.proxies.lists)) {
    if (replace) { writeJSON('proxies.json', bundle.proxies); summary.proxies = { set: bundle.proxies.lists.length }; }
    else {
      const cur = getProxies();
      const byName = new Map(cur.lists.map(l => [l.name, l]));
      let added = 0, updated = 0;
      for (const l of bundle.proxies.lists) {
        if (!l || !l.name) continue;
        if (byName.has(l.name)) { byName.get(l.name).raw = l.raw; updated++; }
        else { cur.lists.push({ name: l.name, raw: l.raw }); added++; }
      }
      writeJSON('proxies.json', cur); summary.proxies = { added, updated };
    }
  }

  if (bundle.settings && typeof bundle.settings === 'object') {
    const cur = replace ? {} : readJSON('settings.json', {});
    writeJSON('settings.json', { ...cur, ...bundle.settings });
    summary.settings = { keys: Object.keys(bundle.settings).length };
  }

  if (bundle.lastOrders && typeof bundle.lastOrders === 'object') {
    const cur = replace ? {} : getLastOrders();
    for (const k in bundle.lastOrders) cur[k] = Math.max(cur[k] || 0, bundle.lastOrders[k] || 0);
    writeJSON('last-orders.json', cur);
    summary.lastOrders = { keys: Object.keys(bundle.lastOrders).length };
  }

  return summary;
}

module.exports = {
  getTasks, createTask, updateTask, deleteTask,
  getPokemonCenterTasks, savePokemonCenterTasks,
  getWalmartTasks, saveWalmartTasks,
  getTargetTasks, saveTargetTasks,
  targetOrderLimitReached, recordTargetOrder, recentTargetOrders,
  ORDER_LIMIT_WINDOW_MS, ORDER_LIMIT_MAX,
  getProfiles, createProfile, createProfilesBulk, updateProfile, deleteProfile,
  getGroups, addProfilesToGroup, removeProfilesFromGroup, setProfileGroups,
  getCouponChecked, setCouponChecked, clearCouponChecked, couponCheckedStats,
  getRound1Profiles, saveRound1Profiles, importRound1Profiles,
  getProxies, saveProxyList, deleteProxyList, getProxyLines,
  getAccounts, getAccountCreds, setAccountCookie, accountForProfile, addAccountsBulk, addGeneratedAccount, updateAccount, deleteAccount,
  getWatchlist, saveWatchlist,
  getLastOrders, setLastOrder,
  getLastCarted, setLastCarted, recentlyCartedIds,
  getSettings, saveSettings,
  exportAll, importAll,
};
