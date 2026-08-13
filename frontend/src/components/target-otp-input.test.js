import { targetOtpForTask, validTargetOtp } from './target-otp';

test('selects only the login-code request owned by the task row', () => {
  const pending = [
    { email: 'one@example.com', taskId: 'task-1', since: 1 },
    { email: 'two@example.com', taskId: 'task-2', since: 2 },
  ];
  expect(targetOtpForTask(pending, 'task-2')).toEqual(pending[1]);
  expect(targetOtpForTask(pending, 'task-3')).toBeNull();
});

test('uses account email only for legacy requests without a task id', () => {
  const pending = [{ email: 'Person@Example.com', taskId: '', since: 1 }];
  expect(targetOtpForTask(pending, 'task-1', 'person@example.com')).toEqual(pending[0]);
  expect(targetOtpForTask(pending, 'task-1', 'different@example.com')).toBeNull();
});

test('accepts complete numeric Target codes only', () => {
  expect(validTargetOtp('123456')).toBe(true);
  expect(validTargetOtp('1234')).toBe(false);
  expect(validTargetOtp('12345678')).toBe(false);
  expect(validTargetOtp('123')).toBe(false);
  expect(validTargetOtp('123456789')).toBe(false);
  expect(validTargetOtp('12a456')).toBe(false);
});
