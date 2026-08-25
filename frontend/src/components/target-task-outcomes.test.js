// CRA 3's Jest transform does not load named exports from this existing .mjs module. These tests
// exercise task outcomes/reset only, so keep that unrelated monitor telemetry boundary inert.
jest.mock('./target-monitor-bandwidth.mjs', () => ({
  emptyTargetMonitorBandwidthState: () => ({ version: 1, mainRunId: '', runs: {} }),
  reduceTargetMonitorBandwidth: state => state,
  stopTargetMonitorBandwidthRuns: state => state,
}));

import { reducer } from './store';

const outcome = (taskId, eventId, eventType, occurredAt) => ({
  type: 'targetOutcome', taskId, eventId, eventType, occurredAt,
});
test('Target launch paints Starting immediately for every accepted task id', () => {
  let state = reducer(undefined, { type: '@@test/init' });
  state = reducer(state, { type: 'targetLaunch', taskIds: ['task-a', 'task-b'] });
  expect(state.target.taskStatus['task-a']).toMatchObject({
    state: 'Starting', label: 'Starting', running: true,
  });
  expect(state.target.taskStatus['task-b']).toMatchObject({
    state: 'Starting', label: 'Starting', running: true,
  });
});

test('Target checkout counts are per-run, deduplicated, and survive status rotation and completion', () => {
  let state = reducer(undefined, { type: '@@test/init' });
  state = reducer(state, { type: 'targetRunStarted', taskIds: ['task-a', 'task-b'], startedAt: 100 });

  state = reducer(state, outcome('task-a', 'event-0000000000', 'carted', 105));
  state = reducer(state, outcome('task-a', 'event-0000000001', 'checkout', 110));
  state = reducer(state, outcome('task-a', 'event-0000000001', 'checkout', 110));
  state = reducer(state, outcome('task-a', 'event-0000000002', 'decline', 120));
  state = reducer(state, outcome('task-a', 'event-0000000003', 'checkout', 130));
  state = reducer(state, outcome('task-a', 'event-0000000004', 'carted', 140));

  expect(state.target.taskOutcomes['task-a']).toMatchObject({
    carted: 2,
    checkouts: 2,
    declines: 1,
    lastCheckoutAt: 130,
    startedAt: 100,
  });

  state = reducer(state, {
    type: 'targetStatus', taskId: 'task-a', state: 'Waiting For Restock',
    label: 'Waiting For Restock', color: '#6DACFF', running: true,
  });
  state = reducer(state, { type: 'targetDone', taskId: 'task-a' });
  expect(state.target.taskOutcomes['task-a'].checkouts).toBe(2);

  state = reducer(state, {
    type: 'targetStatus', taskId: 'task-b', state: 'Starting', label: 'Starting', running: true,
  });
  state = reducer(state, { type: 'targetDone', taskIds: ['task-b'] });
  expect(state.target.taskStatus['task-b']).toBeUndefined();

  // A late event from the prior run is ignored after the new run starts.
  state = reducer(state, { type: 'targetRunStarted', taskIds: ['task-a'], startedAt: 200 });
  state = reducer(state, outcome('task-a', 'event-0000000004', 'checkout', 199));
  expect(state.target.taskOutcomes['task-a'].checkouts).toBe(0);
  expect(state.target.taskOutcomes['task-a'].carted).toBe(0);
  expect(state.target.taskOutcomes['task-a'].declines).toBe(0);
  expect(state.target.taskOutcomes['task-b'].checkouts).toBe(0);
});

test('additive starts reset only accepted task ids and task deletion clears outcomes', () => {
  let state = reducer(undefined, { type: '@@test/init' });
  state = reducer(state, outcome('task-a', 'event-0000000010', 'checkout', 10));
  state = reducer(state, outcome('task-b', 'event-0000000011', 'checkout', 11));
  state = reducer(state, { type: 'targetRunStarted', taskIds: ['task-b'], startedAt: 20 });

  expect(state.target.taskOutcomes['task-a'].checkouts).toBe(1);
  expect(state.target.taskOutcomes['task-b'].checkouts).toBe(0);

  state = reducer(state, { type: 'targetTaskDelete', id: 'task-a' });
  expect(state.target.taskOutcomes['task-a']).toBeUndefined();
  state = reducer(state, { type: 'targetTasksClear' });
  expect(state.target.taskOutcomes).toEqual({});
});

test('task reset clears only run-scoped UI state and preserves task configuration', () => {
  let state = reducer(undefined, { type: '@@test/init' });
  const task = {
    id: 'task-reset', accountId: 'account-1', proxyListName: 'Residential',
    loopCheckout: false, createdAt: 123,
  };
  state = reducer(state, { type: 'targetTasksAdd', tasks: [task] });
  state = reducer(state, { type: 'targetRunStarted', taskIds: [task.id], startedAt: 100 });
  state = reducer(state, outcome(task.id, 'event-reset-0001', 'checkout', 110));
  state = reducer(state, {
    type: 'targetStatus', taskId: task.id, state: 'Successful', label: 'Successful',
    color: '#34ca6e', taskState: 3, running: false,
  });
  state = reducer(state, { type: 'targetLog', taskId: task.id, line: 'Checked out', at: 120 });
  state = reducer(state, {
    type: 'targetProxyEditSent', taskId: task.id, group: 'Residential', at: 125,
  });
  state = reducer(state, {
    type: 'targetOtp',
    pending: [
      { taskId: task.id, email: 'reset@example.com', phase: 'manual' },
      { taskId: 'task-other', email: 'other@example.com', phase: 'polling' },
    ],
  });

  state = reducer(state, { type: 'targetTaskReset', id: task.id, email: 'reset@example.com' });

  expect(state.target.tasks).toEqual([task]);
  expect(state.target.taskStatus[task.id]).toBeUndefined();
  expect(state.target.taskOutcomes[task.id]).toBeUndefined();
  expect(state.target.proxyStatus[task.id]).toBeUndefined();
  expect(state.target.taskLogs[task.id]).toBeUndefined();
  expect(state.target.otpPending).toEqual([
    { taskId: 'task-other', email: 'other@example.com', phase: 'polling' },
  ]);
});
