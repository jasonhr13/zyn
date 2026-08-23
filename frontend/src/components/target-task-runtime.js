import { summarizeGroupDropPulse, targetStatusTone, targetTaskIsRunning } from './target-task-status';
import { targetOtpForTask } from './target-otp';
import { showOperatorLogs } from './operator-logs';

export const EMPTY_TARGET_LOGS = Object.freeze([]);
export const EMPTY_OUTCOME = Object.freeze({});

const emptyMap = Object.freeze(new Map());
let accountsCache = { source: null, byId: emptyMap };
let profilesCache = { source: null, byEmail: emptyMap, checkout: null };

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.list)) return value.list;
  if (value && Array.isArray(value.profiles)) return value.profiles;
  return [];
}

export function accountsById(accounts) {
  if (accountsCache.source === accounts) return accountsCache.byId;
  const byId = new Map();
  for (const account of (accounts || [])) {
    if (account && account.id != null) byId.set(String(account.id), account);
  }
  accountsCache = { source: accounts, byId };
  return byId;
}

export function profileListFrom(profiles) {
  return asArray(profiles)
    .filter(profile => profile && profile.profileType !== 'pokemoncenter' && profile.profileType !== 'walmart');
}

export function checkoutProfilesByEmail(profiles) {
  if (profilesCache.source === profiles && profilesCache.checkout === 'target') return profilesCache.byEmail;
  const byEmail = new Map();
  for (const profile of profileListFrom(profiles)) {
    const email = String(profile.email || '').trim().toLowerCase();
    if (email && !byEmail.has(email)) byEmail.set(email, profile);
  }
  profilesCache = { source: profiles, byEmail, checkout: 'target' };
  return byEmail;
}

export function accountForTask(accounts, task) {
  if (!task) return null;
  return accountsById(accounts).get(String(task.accountId)) || null;
}

export function profileForAccountId(profiles, accounts, accountId) {
  const account = accountsById(accounts).get(String(accountId));
  const email = String((account && account.email) || '').trim().toLowerCase();
  if (!email) return null;
  return checkoutProfilesByEmail(profiles).get(email) || null;
}

function outcomeCount(outcome, key) {
  return Math.max(0, Number(outcome && outcome[key]) || 0);
}

export function selectTargetTaskRuntime(target = {}, task, accountEmail = '') {
  const id = task && task.id;
  if (!id) {
    return {
      status: undefined,
      proxyStatus: null,
      outcome: EMPTY_OUTCOME,
      carted: 0,
      checkouts: 0,
      declines: 0,
      otpRequest: null,
      hasLogs: false,
      canReset: false,
    };
  }
  const status = (target.taskStatus || {})[id];
  const proxy = (target.proxyStatus || {})[id];
  const proxyStatus = proxy && !proxy.hidden ? proxy : null;
  const outcomes = target.taskOutcomes || {};
  const hasOutcome = Object.prototype.hasOwnProperty.call(outcomes, id);
  const outcome = hasOutcome ? outcomes[id] : EMPTY_OUTCOME;
  const logs = (target.taskLogs || {})[id] || EMPTY_TARGET_LOGS;
  const hasLogs = logs.length > 0;
  const otpRequest = targetOtpForTask(target.otpPending, id, accountEmail);
  return {
    status,
    proxyStatus,
    outcome,
    carted: outcomeCount(outcome, 'carted'),
    checkouts: outcomeCount(outcome, 'checkouts'),
    declines: outcomeCount(outcome, 'declines'),
    otpRequest,
    hasLogs,
    canReset: Boolean(status || hasOutcome || proxy || hasLogs || otpRequest),
  };
}

export function selectTargetGroupRuntime(target = {}, tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  const stats = { total: list.length, running: 0, error: 0 };
  for (const task of list) {
    const status = (target.taskStatus || {})[task.id];
    if (targetTaskIsRunning(status)) stats.running += 1;
    if (targetStatusTone(status) === 'error') stats.error += 1;
  }
  return {
    ...stats,
    pulse: summarizeGroupDropPulse(list, {
      statusFor: task => (target.taskStatus || {})[task.id],
      cartedCountFor: task => outcomeCount((target.taskOutcomes || {})[task.id], 'carted'),
      checkoutCountFor: task => outcomeCount((target.taskOutcomes || {})[task.id], 'checkouts'),
      declineCountFor: task => outcomeCount((target.taskOutcomes || {})[task.id], 'declines'),
    }),
  };
}

export function selectTargetWorkspaceRuntime(target = {}, groups) {
  const list = Array.isArray(groups) ? groups : [];
  const sum = { groups: list.length, tasks: 0, running: 0, attention: 0 };
  for (const group of list) {
    const stats = selectTargetGroupRuntime(target, group && group.tasks);
    sum.tasks += stats.total;
    sum.running += stats.running;
    sum.attention += stats.error;
  }
  return sum;
}

export function mapTaskRowState(state, { task }) {
  const account = accountForTask(state.accounts, task);
  const runtime = selectTargetTaskRuntime(state.target, task, account && account.email);
  return {
    account,
    profile: profileForAccountId(state.profiles, state.accounts, task && task.accountId),
    status: runtime.status,
    proxyStatus: runtime.proxyStatus,
    checkouts: runtime.checkouts,
    declines: runtime.declines,
    otpRequest: runtime.otpRequest,
    canReset: runtime.canReset,
  };
}

export function mapTaskDetailState(state, { task }) {
  const row = mapTaskRowState(state, { task });
  const showLogs = showOperatorLogs(state.settings);
  return {
    ...row,
    showOperatorLogs: showLogs,
    taskLogs: showLogs
      ? (((state.target && state.target.taskLogs) || {})[task && task.id] || EMPTY_TARGET_LOGS)
      : EMPTY_TARGET_LOGS,
  };
}

export function mapGroupRuntimeState(state, { group, tasks }) {
  return selectTargetGroupRuntime(state.target, (group && group.tasks) || tasks);
}
