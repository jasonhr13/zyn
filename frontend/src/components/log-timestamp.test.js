import { formatLogTime, timestampLogLine, timestampLogLines } from './log-timestamp';
import { reducer } from './store';

test('formats log times with local hours, minutes, and seconds', () => {
  const at = new Date(2026, 7, 10, 9, 7, 3).getTime();
  expect(formatLogTime(at)).toBe('09:07:03');
  expect(timestampLogLine('Watching 14 items', at)).toBe('[09:07:03] Watching 14 items');
});

test('timestamps every line without duplicating existing time prefixes', () => {
  const at = new Date(2026, 7, 10, 21, 42, 18).getTime();
  expect(timestampLogLine('[21:42:17] already stamped', at)).toBe('[21:42:17] already stamped');
  expect(timestampLogLine('[9:42:17 PM] locale timestamp', at)).toBe('[9:42:17 PM] locale timestamp');
  expect(timestampLogLine('first\nsecond', at)).toBe('[21:42:18] first\n[21:42:18] second');
  expect(timestampLogLines(['one', 'two'], at)).toEqual(['[21:42:18] one', '[21:42:18] two']);
});

test('timestamps shared and per-task log entries when they enter the store', () => {
  const at = new Date(2026, 7, 10, 21, 42, 18).getTime();
  let state = reducer(undefined, { type: '@@test/init' });
  state = reducer(state, { type: 'targetLog', line: 'Engine connected', at });
  state = reducer(state, { type: 'targetLog', taskId: 'task-1', lines: ['Carting', 'Checking out'], at });
  state = reducer(state, { type: 'pokemonLog', line: 'Queue cleared', at });

  expect(state.target.logs).toEqual(['[21:42:18] Engine connected']);
  expect(state.target.taskLogs['task-1']).toEqual([
    '[21:42:18] Carting',
    '[21:42:18] Checking out',
  ]);
  expect(state.pokemon.logs).toEqual(['[21:42:18] Queue cleared']);
});
