import { reducer } from './store';
import {
  mapGroupRuntimeState,
  mapTaskDetailState,
  mapTaskRowState,
  selectTargetTaskRuntime,
} from './target-task-runtime';

jest.mock('./target-monitor-bandwidth.mjs', () => ({
  emptyTargetMonitorBandwidthState: () => ({ version: 1, mainRunId: '', runs: {} }),
  reduceTargetMonitorBandwidth: state => state,
  stopTargetMonitorBandwidthRuns: state => state,
}));

const account = { id: 'acct-1', email: 'one@example.com', site: 'target' };
const task = { id: 'task-1', accountId: 'acct-1' };
const other = { id: 'task-2', accountId: 'acct-2' };

function withAccounts(state) {
  return reducer(state, { type: 'update', obj: { accounts: [account], profiles: [{ id: 'p1', email: 'one@example.com' }] } });
}

test('a sibling Target status change keeps this row’s mapped props referentially stable', () => {
  let state = withAccounts(reducer(undefined, { type: '@@test/init' }));
  state = reducer(state, {
    type: 'targetStatus', taskId: task.id, state: 'Waiting For Restock',
    label: 'Waiting For Restock', running: true,
  });
  const previous = mapTaskRowState(state, { task });

  state = reducer(state, {
    type: 'targetStatus', taskId: other.id, state: 'Adding To Cart',
    label: 'Adding To Cart', running: true,
  });
  const next = mapTaskRowState(state, { task });

  expect(next).toEqual(previous);
  expect(next.status).toBe(previous.status);
  expect(next.account).toBe(previous.account);
  expect(next.otpRequest).toBe(previous.otpRequest);
});

test('only the changed Target row receives a new status object', () => {
  let state = withAccounts(reducer(undefined, { type: '@@test/init' }));
  state = reducer(state, {
    type: 'targetStatus', taskId: task.id, state: 'Waiting For Restock',
    label: 'Waiting For Restock', running: true,
  });
  const before = mapTaskRowState(state, { task });
  state = reducer(state, {
    type: 'targetStatus', taskId: task.id, state: 'Adding To Cart',
    label: 'Adding To Cart', running: true,
  });
  const after = mapTaskRowState(state, { task });
  expect(after.status).not.toBe(before.status);
  expect(after.status.label).toBe('Adding To Cart');
});

test('task logs are not part of the list-row slice, so a log line does not dirty the row', () => {
  let state = withAccounts(reducer(undefined, { type: '@@test/init' }));
  state = reducer(state, {
    type: 'targetStatus', taskId: task.id, state: 'Waiting For Restock',
    label: 'Waiting For Restock', running: true,
  });
  const previous = mapTaskRowState(state, { task });
  state = reducer(state, { type: 'targetLog', taskId: task.id, line: 'Getting session', at: 1 });
  const next = mapTaskRowState(state, { task });
  expect(next).toEqual(previous);
  expect(next.status).toBe(previous.status);
  expect(mapTaskDetailState(state, { task }).taskLogs).toEqual([]);
  state = reducer(state, { type: 'update', obj: { settings: { showOperatorLogs: true } } });
  expect(mapTaskDetailState(state, { task }).taskLogs.some(line => String(line).includes('Getting session'))).toBe(true);
});

test('group runtime only changes counts for the group that moved', () => {
  const groupA = { id: 'g1', tasks: [task] };
  const groupB = { id: 'g2', tasks: [other] };
  let state = withAccounts(reducer(undefined, { type: '@@test/init' }));
  const beforeB = mapGroupRuntimeState(state, { group: groupB });
  state = reducer(state, {
    type: 'targetStatus', taskId: task.id, state: 'Adding To Cart',
    label: 'Adding To Cart', running: true,
  });
  expect(mapGroupRuntimeState(state, { group: groupB })).toEqual(beforeB);
  expect(mapGroupRuntimeState(state, { group: groupA }).running).toBe(1);
  expect(mapGroupRuntimeState(state, { group: groupA }).pulse.carting).toBe(1);
});

test('group drop pulse keeps carted and failed counts after the task leaves those statuses', () => {
  const group = { id: 'g1', tasks: [task] };
  let state = withAccounts(reducer(undefined, { type: '@@test/init' }));
  state = reducer(state, { type: 'targetRunStarted', taskIds: [task.id], startedAt: 100 });
  state = reducer(state, {
    type: 'targetOutcome', taskId: task.id, eventId: 'cart-1', eventType: 'carted', occurredAt: 110,
  });
  state = reducer(state, {
    type: 'targetOutcome', taskId: task.id, eventId: 'fail-1', eventType: 'decline', occurredAt: 120,
  });
  state = reducer(state, {
    type: 'targetStatus', taskId: task.id, state: 'Waiting For Restock',
    label: 'Waiting For Restock', running: true,
  });
  expect(mapGroupRuntimeState(state, { group }).pulse).toEqual({
    carting: 0, submitting: 1, checkouts: 0, failures: 1,
  });
});

test('selectTargetTaskRuntime hides completed proxy notices and counts this-run checkouts', () => {
  const runtime = selectTargetTaskRuntime({
    taskStatus: { 'task-1': { label: 'Waiting For Restock', running: true } },
    proxyStatus: { 'task-1': { label: 'Proxy Updated', hidden: true } },
    taskOutcomes: { 'task-1': { carted: 3, checkouts: 2, declines: 1 } },
    taskLogs: { 'task-1': ['ok'] },
    otpPending: [],
  }, task, 'one@example.com');
  expect(runtime.proxyStatus).toBe(null);
  expect(runtime.carted).toBe(3);
  expect(runtime.checkouts).toBe(2);
  expect(runtime.declines).toBe(1);
  expect(runtime.canReset).toBe(true);
});
