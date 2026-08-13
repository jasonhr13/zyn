'use strict';

const { parseWatchedItems, resolveProfileForTask } = require('./target-group-launch');

function issue(code, title, detail, extra = {}) {
  return { code, title, detail, ...extra };
}

function count(value) {
  return Math.max(0, Number(value) || 0);
}

function accountList(accounts) {
  return Array.isArray(accounts) ? accounts : [];
}

function taskSelection(group, taskIds) {
  const tasks = Array.isArray(group && group.tasks) ? group.tasks : [];
  if (!Array.isArray(taskIds)) return tasks;
  const selected = new Set(taskIds.map(String));
  return tasks.filter(task => selected.has(String(task && task.id)));
}

function rawItemMaxPriceIsInvalid(group) {
  return (Array.isArray(group && group.items) ? group.items : []).find(item => {
    const text = String(item && item.maxPrice || '').trim().replace(/^\$/, '').replace(/,/g, '');
    if (!text) return false;
    if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return true;
    const value = Number(text);
    return !Number.isFinite(value) || value <= 0 || value > 100000;
  }) || null;
}

function evaluateTargetReadiness(group, options = {}) {
  const candidate = group && typeof group === 'object' ? group : {};
  const accounts = accountList(options.accounts);
  const profiles = options.profiles || [];
  const tasks = taskSelection(candidate, options.taskIds);
  const items = parseWatchedItems(candidate);
  const proxyCounts = options.proxyCounts && typeof options.proxyCounts === 'object'
    ? options.proxyCounts : {};
  const bank = options.bank && typeof options.bank === 'object' ? options.bank : null;
  const settings = options.settings && typeof options.settings === 'object' ? options.settings : {};
  const blockers = [];
  const warnings = [];
  const checks = [];

  const addCheck = (code, status, title, detail) => checks.push({ code, status, title, detail });

  if (!items.length) {
    blockers.push(issue('watch-list-empty', 'No Target SKUs', 'Add at least one valid Target TCIN.'));
    addCheck('watch-list', 'fail', 'Watch list', 'No valid Target TCINs');
  } else {
    addCheck('watch-list', 'pass', 'Watch list', `${items.length} valid SKU${items.length === 1 ? '' : 's'}`);
  }
  const invalidItem = rawItemMaxPriceIsInvalid(candidate);
  if (invalidItem) {
    const sku = String(invalidItem.sku || invalidItem.tcin || invalidItem.monitorInput || 'unknown');
    blockers.push(issue('invalid-max-price', 'Invalid maximum price', `SKU ${sku} needs a positive price with no more than two decimals.`, { sku }));
    addCheck('max-price', 'fail', 'Maximum prices', `Invalid price for SKU ${sku}`);
  } else {
    const limited = items.filter(item => item.maxPrice).length;
    addCheck('max-price', 'pass', 'Maximum prices', limited
      ? `${limited} SKU${limited === 1 ? '' : 's'} protected by a strict ceiling`
      : 'No SKU price ceilings');
  }
  addCheck(
    'stock-confidence',
    'pass',
    'Stock confidence',
    candidate.stockConfidence === 'confirmed-10-plus'
      ? 'Requires a reported quantity of 10 or more'
      : 'Accepts any valid in-stock signal',
  );

  if (!tasks.length) {
    blockers.push(issue('tasks-empty', 'No runnable tasks', 'Add an account task or select at least one existing task.'));
  }

  const missingAccounts = [];
  const missingCredentials = [];
  const missingProfiles = [];
  const localTasks = [];
  const badProxies = new Map();
  let loginCookiesNeeded = 0;
  for (const task of tasks) {
    const taskId = String(task && task.id || '');
    const account = accounts.find(item => String(item && item.id) === String(task && task.accountId));
    if (!account) {
      missingAccounts.push(taskId);
      continue;
    }
    const hasSession = Boolean(account.cookie || account.hasSession);
    if (!account.hasPassword && !hasSession) missingCredentials.push(taskId);
    if (!hasSession) loginCookiesNeeded += 1;
    if (!resolveProfileForTask(task, accounts, profiles)) missingProfiles.push(taskId);

    const proxyRef = String(task.proxyListName || candidate.proxyListName || '').trim();
    if (!proxyRef || /^local$/i.test(proxyRef)) {
      localTasks.push(taskId);
      continue;
    }
    const resolved = proxyCounts[proxyRef];
    if (!resolved || resolved.ok !== true || count(resolved.count) < 1) {
      badProxies.set(proxyRef, resolved && resolved.error ? String(resolved.error) : 'missing or empty');
    }
  }

  if (missingAccounts.length) blockers.push(issue(
    'missing-account', 'Missing Target accounts', `${missingAccounts.length} selected task${missingAccounts.length === 1 ? '' : 's'} reference an account that no longer exists.`,
    { taskIds: missingAccounts },
  ));
  if (missingCredentials.length) blockers.push(issue(
    'missing-credentials', 'Target sign-in unavailable', `${missingCredentials.length} selected account${missingCredentials.length === 1 ? '' : 's'} have neither a saved password nor a reusable session.`,
    { taskIds: missingCredentials },
  ));
  if (missingProfiles.length) blockers.push(issue(
    'missing-profile', 'Missing checkout profiles', `${missingProfiles.length} selected account${missingProfiles.length === 1 ? '' : 's'} do not have a matching profile email.`,
    { taskIds: missingProfiles },
  ));
  if (badProxies.size) blockers.push(issue(
    'proxy-unavailable', 'Proxy group unavailable', [...badProxies.entries()].map(([name, reason]) => `${name}: ${reason}`).join(' · '),
    { proxyRefs: [...badProxies.keys()] },
  ));

  const taskBlockCount = missingAccounts.length + missingCredentials.length + missingProfiles.length;
  addCheck('tasks', taskBlockCount ? 'fail' : tasks.length ? 'pass' : 'fail', 'Account tasks', taskBlockCount
    ? `${taskBlockCount} account/profile issue${taskBlockCount === 1 ? '' : 's'}`
    : tasks.length
      ? `${tasks.length} task${tasks.length === 1 ? '' : 's'} ready`
      : 'No tasks selected');
  addCheck('proxies', badProxies.size ? 'fail' : localTasks.length ? 'warning' : 'pass', 'Proxy routing', badProxies.size
    ? `${badProxies.size} proxy group${badProxies.size === 1 ? '' : 's'} unavailable`
    : localTasks.length
      ? `${localTasks.length} task${localTasks.length === 1 ? '' : 's'} will use the local connection`
      : 'Selected proxy groups contain proxies');
  if (localTasks.length) warnings.push(issue(
    'local-proxy', 'Local connection selected', `${localTasks.length} task${localTasks.length === 1 ? '' : 's'} will monitor and check out from this device’s IP.`,
    { taskIds: localTasks },
  ));

  const atcPerTask = Math.max(0, Number.parseInt(String(settings.targetAtcCookiesPerTask || '3'), 10) || 0);
  const atcNeeded = atcPerTask > 0 ? atcPerTask * tasks.length : 0;
  if (!bank) {
    warnings.push(issue('cookie-bank-offline', 'Cookie bank unavailable', 'The Target cookie broker is offline or still starting. Tasks may wait before carting.'));
    addCheck('cookie-bank', 'warning', 'Cookie bank', 'Broker offline or still starting');
  } else {
    const atc = count(bank.atc);
    const login = count(bank.login);
    const deficits = [];
    if (atcNeeded > 0 && atc < atcNeeded) deficits.push(`${atc}/${atcNeeded} ATC cookies`);
    if (loginCookiesNeeded > 0 && login < loginCookiesNeeded) deficits.push(`${login}/${loginCookiesNeeded} login cookies`);
    if (deficits.length) {
      warnings.push(issue('cookie-bank-deficit', 'Cookie bank below target', `${deficits.join(' · ')}. Tasks can start, but may wait for cookies.`));
      addCheck('cookie-bank', 'warning', 'Cookie bank', deficits.join(' · '));
    } else {
      addCheck('cookie-bank', 'pass', 'Cookie bank', atcNeeded > 0
        ? `${atc} ATC and ${login} login cookies ready`
        : `${atc} ATC and ${login} login cookies available`);
    }

    const scaling = bank.health && bank.health.scaling || {};
    const samples = count(scaling.recentSamples);
    const errorRate = Number(scaling.recentErrorRate);
    if (samples >= 5 && Number.isFinite(errorRate) && errorRate >= 0.5) {
      warnings.push(issue('harvester-pressure', 'High recent harvester failure rate', `${Math.round(errorRate * 100)}% of the last ${samples} samples failed.`));
    }
  }

  const harvesters = Array.isArray(settings.targetHarvesters) ? settings.targetHarvesters : [];
  const hasAtcHarvester = harvesters.some(item => item && item.enabled !== false
    && ['atc', 'auto'].includes(String(item.type || 'auto')));
  const extension = bank && bank.extensionHarvester || {};
  const extensionAvailable = extension.configured === true && extension.listening === true;
  const atcDeficient = atcNeeded > 0 && (!bank || count(bank.atc) < atcNeeded);
  if (atcDeficient && !hasAtcHarvester && !extensionAvailable) {
    warnings.push(issue('no-atc-harvester', 'No ATC harvester available', 'The bank is below target and no enabled in-app or reachable extension harvester can replenish it.'));
  }

  const level = blockers.length ? 'blocked' : warnings.length ? 'warning' : 'ready';
  return {
    ok: !blockers.length,
    level,
    blockers,
    warnings,
    checks,
    counts: {
      tasks: tasks.length,
      skus: items.length,
      priceLimitedSkus: items.filter(item => item.maxPrice).length,
      localTasks: localTasks.length,
      atcNeeded,
      atcAvailable: count(bank && bank.atc),
      loginNeeded: loginCookiesNeeded,
      loginAvailable: count(bank && bank.login),
    },
  };
}

module.exports = { evaluateTargetReadiness };
