'use strict';

function parseSkus(raw) {
  return String(raw || '').split(/[\n,]/).map(line => {
    const value = line.trim();
    if (!value) return '';
    const marker = value.toUpperCase().lastIndexOf('A-');
    const candidate = marker >= 0 ? value.slice(marker + 2) : value;
    return (candidate.match(/^\d{6,}/) || [])[0] || '';
  }).filter(Boolean).filter((value, index, all) => all.indexOf(value) === index);
}

function normalizeMaxPrice(value) {
  const text = String(value == null ? '' : value).trim().replace(/^\$/, '').replace(/,/g, '');
  if (!text || !/^\d+(?:\.\d{1,2})?$/.test(text)) return '';
  const number = Number(text);
  return Number.isFinite(number) && number > 0 && number <= 100000 ? number.toFixed(2) : '';
}

function parseWatchedItems(group) {
  const candidate = group && typeof group === 'object' ? group : {};
  const bySku = new Map();
  if (Array.isArray(candidate.items)) {
    for (const item of candidate.items) {
      const raw = item && typeof item === 'object'
        ? item.sku || item.tcin || item.monitorInput
        : item;
      const sku = parseSkus(raw)[0];
      if (sku && !bySku.has(sku)) {
        const next = {
          sku,
          maxPrice: normalizeMaxPrice(item && typeof item === 'object' ? item.maxPrice : ''),
        };
        if (item && typeof item === 'object' && item.priority === true) next.priority = true;
        bySku.set(sku, next);
      }
    }
  }
  for (const sku of parseSkus(candidate.skus)) {
    if (!bySku.has(sku)) bySku.set(sku, { sku, maxPrice: '' });
  }
  return [...bySku.values()];
}

function profileList(profiles) {
  const value = profiles || {};
  return (value.list || value.profiles || (Array.isArray(value) ? value : []))
    .filter(profile => profile && profile.profileType !== 'pokemoncenter' && profile.profileType !== 'walmart');
}

function resolveProfileForTask(task, accounts, profiles) {
  if (task && task.profileId) {
    const explicit = profileList(profiles).find(item => String(item.id) === String(task.profileId));
    if (explicit) return explicit;
  }
  const account = (Array.isArray(accounts) ? accounts : [])
    .find(item => String(item.id) === String(task && task.accountId));
  const email = String(account && account.email || '').trim().toLowerCase();
  if (!email) return null;
  return profileList(profiles)
    .find(item => String(item.email || '').trim().toLowerCase() === email) || null;
}

function buildTargetGroupLaunch(group, { accounts = [], profiles = [] } = {}) {
  const candidate = group && typeof group === 'object' ? group : {};
  if (String(candidate.site || 'target').toLowerCase() !== 'target') {
    return { ok: false, error: 'Only Target task groups can be scheduled.' };
  }
  const items = parseWatchedItems(candidate);
  const skus = items.map(item => item.sku);
  if (!items.length) return { ok: false, error: 'Add at least one Target SKU to this task group first.' };

  const tasks = [];
  let skipped = 0;
  for (const task of (Array.isArray(candidate.tasks) ? candidate.tasks : [])) {
    const profile = resolveProfileForTask(task, accounts, profiles);
    if (!profile) {
      skipped += 1;
      continue;
    }
    tasks.push({
      id: String(task.id),
      accountId: String(task.accountId || ''),
      profileId: String(profile.id),
      proxyListName: String(task.proxyListName || candidate.proxyListName || ''),
      loopCheckout: task.loopCheckout != null
        ? task.loopCheckout === true
        : task.repeatCheckout === true,
    });
  }
  if (!tasks.length) {
    return {
      ok: false,
      error: skipped
        ? 'No tasks have matching profiles (account email must match a profile).'
        : 'Nothing to start — group has no tasks.',
    };
  }
  const qty = Math.max(1, Math.min(99, Number.parseInt(candidate.qty, 10) || 2));
  return {
    ok: true,
    config: {
      tasks,
      skus,
      items,
      qty,
      groupId: String(candidate.id || ''),
      useFillerItem: candidate.useFillerItem === true,
      stockConfidence: candidate.stockConfidence === 'confirmed-10-plus' ? 'confirmed-10-plus' : 'any',
      ignoreLowStock: candidate.stockConfidence === 'confirmed-10-plus',
      monitor: {
        groupId: String(candidate.id || ''),
        proxyListName: String(candidate.monitorProxyListName || ''),
        delay: String(candidate.monitorDelay || '4000'),
        ignoreLowStock: candidate.stockConfidence === 'confirmed-10-plus',
        items,
        skus,
        qty,
      },
    },
    skipped,
  };
}

function groupHasRunningTasks(group, isTaskRunning) {
  const check = typeof isTaskRunning === 'function' ? isTaskRunning : () => false;
  return (Array.isArray(group && group.tasks) ? group.tasks : [])
    .some(task => check(String(task.id)));
}

function otherTargetGroupRunning(groups, groupId, isTaskRunning, options = {}) {
  const monitorGroupId = String(options.monitorGroupId || '').trim();
  return (Array.isArray(groups) ? groups : []).find(group => {
    if (String(group.id) === String(groupId)) return false;
    if (String(group.site || 'target').toLowerCase() !== 'target') return false;
    if (groupHasRunningTasks(group, isTaskRunning)) return true;
    return !!(monitorGroupId && String(group.id) === monitorGroupId);
  }) || null;
}

module.exports = {
  parseSkus,
  parseWatchedItems,
  resolveProfileForTask,
  buildTargetGroupLaunch,
  groupHasRunningTasks,
  otherTargetGroupRunning,
};
