import { reducer } from './store';

const outcome = (taskId, eventId, eventType, occurredAt) => ({
  type: 'targetOutcome', taskId, eventId, eventType, occurredAt,
});
test('Target checkout counts are per-run, deduplicated, and survive status rotation and completion', () => {
  let state = reducer(undefined, { type: '@@test/init' });
  state = reducer(state, { type: 'targetRunStarted', taskIds: ['task-a', 'task-b'], startedAt: 100 });

  state = reducer(state, outcome('task-a', 'event-0000000001', 'checkout', 110));
  state = reducer(state, outcome('task-a', 'event-0000000001', 'checkout', 110));
  state = reducer(state, outcome('task-a', 'event-0000000002', 'decline', 120));
  state = reducer(state, outcome('task-a', 'event-0000000003', 'checkout', 130));

  expect(state.target.taskOutcomes['task-a']).toMatchObject({
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

  // A late event from the prior run is ignored after the new run starts.
  state = reducer(state, { type: 'targetRunStarted', taskIds: ['task-a'], startedAt: 200 });
  state = reducer(state, outcome('task-a', 'event-0000000004', 'checkout', 199));
  expect(state.target.taskOutcomes['task-a'].checkouts).toBe(0);
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
