import { targetDropPhase, targetStatusTone, targetTaskIsRunning, summarizeGroupDropPulse } from './target-task-status';

const status = (label, extra = {}) => ({ label, state: label, running: true, ...extra });

test.each([
  [null, 'idle'],
  [status('Watching for restock', { color: '#fb5454' }), 'watching'],
  [status('Waiting For Restock'), 'watching'],
  [status('Getting Product(s)'), 'watching'],
  [status('Out Of Stock', { color: '#fb5454' }), 'watching'],
  [status('Product Found: Error Trainer Box From: shared monitor', { color: '#fb5454' }), 'carting'],
  [status('Product Found: Successful Search From: shared monitor'), 'carting'],
  [status('Product In Stock'), 'carting'],
  [status('Adding To Cart'), 'carting'],
  [status('Getting Cart'), 'carting'],
  [status('Waiting For Shape'), 'checkout'],
  [status('Carted'), 'submitting'],
  [status('Getting Cart Info'), 'submitting'],
  [status('Preparing Checkout'), 'submitting'],
  [status('Setting Address'), 'submitting'],
  [status('Setting Payment'), 'submitting'],
  [status('Out Of Stock, Checking Cart'), 'submitting'],
  [status('Submitting Payment'), 'submitting'],
  [status('Submitting CVV'), 'submitting'],
  [status('Submitting Order'), 'submitting'],
  [status('Completed Task Initilization'), 'checkout'],
  [status('Rotated Profile To: Error Recovery'), 'submitting'],
  [status('Rotated Profile To: Waiting For Restock'), 'submitting'],
  [status('Switched To Waiting For Restock'), 'submitting'],
  [status('Waiting For Order'), 'success'],
  [status('Getting Order Status'), 'success'],
  [status('Successful', { taskState: 3 }), 'success'],
  [status('Payment Declined', { taskState: 4 }), 'error'],
  [status('Could Not Switch To ISP', { color: '#fb5454' }), 'error'],
  [status('Could Not Switch To Successful', { color: '#fb5454' }), 'error'],
  [status('Task Limit Reached', { color: '#fb5454', running: false }), 'error'],
  [status('Unexpected response', { color: '#fb5454' }), 'error'],
  [status('Unrecognized active step', { color: '#6DACFF' }), 'checkout'],
  [status('Stopped', { running: false }), 'idle'],
])('maps Target status %# to %s', (input, expected) => {
  expect(targetStatusTone(input)).toBe(expected);
});

test.each([
  [null, ''],
  [status('Waiting For Restock'), ''],
  [status('Product Found: Prismatic Evolutions'), ''],
  [status('Adding To Cart'), 'carting'],
  [status('Using Alternate Cart Flow'), 'carting'],
  [status('Carted'), ''],
  [status('Submitting Payment'), 'submitting'],
  [status('Submitting CVV'), 'submitting'],
  [status('Submitting Order'), 'submitting'],
  [status('Successful', { taskState: 3 }), ''],
])('maps Target drop phase %# to %s', (input, expected) => {
  expect(targetDropPhase(input)).toBe(expected);
});

test('group drop pulse counts live cart and persistent carted/checkout/fail outcomes', () => {
  const tasks = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  const statuses = {
    a: status('Adding To Cart'),
    b: status('Submitting Order'),
    c: status('Waiting For Restock'),
    d: status('Submitting Payment'),
  };
  const carted = { a: 1, b: 0, c: 2, d: 1 };
  const checkouts = { a: 1, b: 0, c: 2, d: 0 };
  const declines = { a: 0, b: 1, c: 0, d: 2 };
  expect(summarizeGroupDropPulse(tasks, {
    statusFor: task => statuses[task.id],
    cartedCountFor: task => carted[task.id],
    checkoutCountFor: task => checkouts[task.id],
    declineCountFor: task => declines[task.id],
  })).toEqual({ carting: 1, submitting: 5, checkouts: 3, failures: 3 });
});

test('live submitting still counts once before the carted outcome arrives', () => {
  const tasks = [{ id: 'a' }, { id: 'b' }];
  expect(summarizeGroupDropPulse(tasks, {
    statusFor: task => (task.id === 'a' ? status('Submitting Order') : status('Waiting For Restock')),
    cartedCountFor: () => 0,
    checkoutCountFor: () => 0,
    declineCountFor: () => 0,
  })).toEqual({ carting: 0, submitting: 1, checkouts: 0, failures: 0 });
});

test('visual success and error tones do not change task liveness', () => {
  expect(targetTaskIsRunning(status('Successful', { taskState: 3 }))).toBe(true);
  expect(targetTaskIsRunning(status('Payment Declined', { taskState: 4 }))).toBe(true);
  expect(targetTaskIsRunning(status('Product Found: Idle Hands'))).toBe(true);
  expect(targetTaskIsRunning(status('Rotated Profile To: Stopped Clock'))).toBe(true);
  expect(targetTaskIsRunning({ label: 'Product Found: Successful Search' })).toBe(true);
  expect(targetTaskIsRunning(status('Limit Reached', { running: false }))).toBe(false);
  expect(targetTaskIsRunning({ label: 'Limit Reached' })).toBe(false);
  expect(targetTaskIsRunning(status('Stopped', { running: false }))).toBe(false);
});
