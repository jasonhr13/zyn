import { visibleLogWindow, LOG_ROW_HEIGHT, LOG_OVERSCAN } from './virtual-log-view';

test('an empty log has no window', () => {
  expect(visibleLogWindow({ lineCount: 0, viewportHeight: 260 })).toEqual({
    start: 0, end: 0, padTop: 0, padBottom: 0,
  });
});

test('a short log that fits the viewport renders every line and no pads', () => {
  const range = visibleLogWindow({
    scrollTop: 0, viewportHeight: 260, lineCount: 3, rowHeight: 16, overscan: 8,
  });
  expect(range).toEqual({ start: 0, end: 3, padTop: 0, padBottom: 0 });
});

test('a long log only windows the visible slice plus overscan', () => {
  const range = visibleLogWindow({
    scrollTop: 160, viewportHeight: 160, lineCount: 800, rowHeight: 16, overscan: 8,
  });
  // floor(160/16) = 10, minus 8 overscan → start 2
  // ceil(160/16) + 16 = 26 rows → end 28
  expect(range.start).toBe(2);
  expect(range.end).toBe(28);
  expect(range.padTop).toBe(2 * 16);
  expect(range.padBottom).toBe((800 - 28) * 16);
  expect(range.end - range.start).toBeLessThan(40);
});

test('scrolling to the tail still includes the last line', () => {
  const range = visibleLogWindow({
    scrollTop: 800 * LOG_ROW_HEIGHT, viewportHeight: 260, lineCount: 800,
    rowHeight: LOG_ROW_HEIGHT, overscan: LOG_OVERSCAN,
  });
  expect(range.end).toBe(800);
  expect(range.start).toBeLessThan(800);
  expect(range.padBottom).toBe(0);
});
