import { summarizeGroupDropPulse, targetStatusTone, targetTaskIsRunning } from './target-task-status';
import { targetOtpForTask } from './target-otp';

export const EMPTY_TARGET_LOGS = Object.freeze([]);
export const EMPTY_OUTCOME = Object.freeze({});

export function profileListFrom(profiles) {
  const value = profiles || [];
  return (value.list || value.profiles || (Array.isArray(value) ? value : []))
    .filter(profile => profile && profile.profileType !== 'pokemoncenter');
}

export function accountForTask(accounts, task) {
  if (!task) return null;
  return (accounts || []).find(account => String(account.id) === String(task.accountId)) || null;
}

export function profileForAccountId(profiles, accounts, accountId) {
  const account = (accounts || []).find(item => String(item.id) === String(accountId));
  const email = String((account && account.email) || '').trim().toLowerCase();
  if (!email) return null;
  return profileListFrom(profiles).find(profile => String(profile.email || '').trim().toLowerCase() === email) || null;
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
  const logs = ((state.target && state.target.taskLogs) || {})[task && task.id] || EMPTY_TARGET_LOGS;
  return { ...row, taskLogs: logs };
}

export function mapGroupRuntimeState(state, { group, tasks }) {
  return selectTargetGroupRuntime(state.target, (group && group.tasks) || tasks);
}
