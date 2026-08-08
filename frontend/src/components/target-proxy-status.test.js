import { reducer } from './store';
import { isTargetProxyRotationStatus, isTargetProxyStatus } from './target-proxy-status';

const taskStatus = (label, receivedAt) => ({
  type: 'targetStatus',
  taskId: 'task-1',
  state: label,
  label,
  color: label.startsWith('Could Not') ? '#fb5454' : '#34ca6e',
  taskState: 1,
  running: true,
  receivedAt,
});

test('live proxy feedback and late rotation chatter preserve the operational task status', () => {
  let state = reducer(undefined, { type: '@@test/init' });
  state = reducer(state, taskStatus('Watching for restock', 1));
  state = reducer(state, { type: 'targetProxyEditSent', taskId: 'task-1', at: 2, group: 'ISP' });
  state = reducer(state, taskStatus('Switched To ISP', 3));

  expect(state.target.taskStatus['task-1'].label).toBe('Watching for restock');
  expect(state.target.proxyStatus['task-1'].label).toBe('Switched To ISP');

  state = reducer(state, taskStatus('Rotating Proxy', 4));
  expect(state.target.taskStatus['task-1'].label).toBe('Watching for restock');

  state = reducer(state, { type: 'targetProxyStatusClear', taskId: 'task-1', at: 3 });
  expect(state.target.proxyStatus['task-1'].hidden).toBe(true);
  state = reducer(state, taskStatus('Rotating Proxy', 5));
  expect(state.target.taskStatus['task-1'].label).toBe('Watching for restock');

  state = reducer(state, taskStatus('Adding to Cart', 6));
  expect(state.target.taskStatus['task-1'].label).toBe('Adding to Cart');
  expect(state.target.proxyStatus['task-1']).toBeUndefined();
});

test('a queued proxy edit stays armed for its final result after the notice fades', () => {
  let state = reducer(undefined, { type: '@@test/init' });
  state = reducer(state, taskStatus('Watching for restock', 1));
  state = reducer(state, { type: 'targetProxyEditSent', taskId: 'task-1', at: 2, group: 'ISP' });
  state = reducer(state, taskStatus('Switch To ISP (applies after carting)', 3));
  state = reducer(state, { type: 'targetProxyStatusClear', taskId: 'task-1', at: 3 });

  expect(state.target.proxyStatus['task-1'].hidden).toBe(true);
  expect(state.target.proxyStatus['task-1'].pending).toBe(true);

  state = reducer(state, taskStatus('Could Not Switch To ISP', 4));
  expect(state.target.taskStatus['task-1'].label).toBe('Watching for restock');
  expect(state.target.proxyStatus['task-1'].label).toBe('Could Not Switch To ISP');
  expect(state.target.proxyStatus['task-1'].pending).toBe(false);
});

test('similar engine wording is not intercepted for a different outstanding proxy group', () => {
  expect(isTargetProxyStatus('Switched To Out of Stock')).toBe(true);
  expect(isTargetProxyRotationStatus('Rotating Proxy')).toBe(true);
  let state = reducer(undefined, { type: '@@test/init' });
  state = reducer(state, { type: 'targetProxyEditSent', taskId: 'task-1', at: 1, group: 'ISP' });
  state = reducer(state, taskStatus('Switched To Out of Stock', 1));
  expect(state.target.taskStatus['task-1'].label).toBe('Switched To Out of Stock');
  expect(state.target.proxyStatus['task-1'].pending).toBe(true);
  expect(state.target.proxyStatus['task-1'].hidden).toBe(true);
});
