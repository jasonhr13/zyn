import { targetStatusTone, targetTaskIsRunning } from './target-task-status';

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
  [status('Out Of Stock, Checking Cart'), 'checkout'],
  [status('Submitting Payment'), 'checkout'],
  [status('Submitting CVV'), 'checkout'],
  [status('Submitting Order'), 'checkout'],
  [status('Completed Task Initilization'), 'checkout'],
  [status('Rotated Profile To: Error Recovery'), 'checkout'],
  [status('Rotated Profile To: Waiting For Restock'), 'checkout'],
  [status('Switched To Waiting For Restock'), 'checkout'],
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
