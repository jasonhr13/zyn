'use strict';

function parseSkus(raw) {
  return String(raw || '').split(/[\n,]/).map(line => {
    const value = line.trim();
    if (!value) return '';
    const marker = value.toUpperCase().lastIndexOf('A-');
    const candidate = marker >= 0 ? value.slice(marker + 2) : value;
    return (candidate.match(/^\d+/) || [])[0] || '';
  }).filter(Boolean).filter((value, index, all) => all.indexOf(value) === index);
}

function profileList(profiles) {
  const value = profiles || {};
  return value.list || value.profiles || (Array.isArray(value) ? value : []);
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
  const skus = parseSkus(candidate.skus);
  if (!skus.length) return { ok: false, error: 'Add at least one Target SKU to this task group first.' };

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
      repeatCheckout: task.repeatCheckout === true,
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
  return {
    ok: true,
    config: {
      tasks,
      skus,
      qty: Math.max(1, Math.min(99, Number.parseInt(candidate.qty, 10) || 2)),
    },
    skipped,
  };
}

function groupHasRunningTasks(group, isTaskRunning) {
  const check = typeof isTaskRunning === 'function' ? isTaskRunning : () => false;
  return (Array.isArray(group && group.tasks) ? group.tasks : [])
    .some(task => check(String(task.id)));
}

function otherTargetGroupRunning(groups, groupId, isTaskRunning) {
  return (Array.isArray(groups) ? groups : []).find(group => (
    String(group.id) !== String(groupId)
    && String(group.site || 'target').toLowerCase() === 'target'
    && groupHasRunningTasks(group, isTaskRunning)
  )) || null;
}

module.exports = {
  parseSkus,
  resolveProfileForTask,
  buildTargetGroupLaunch,
  groupHasRunningTasks,
  otherTargetGroupRunning,
};
