#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const dashboard = read('frontend/src/components/pages/dashboard.js');
const dashboardCss = read('frontend/src/components/pages/dashboard.css');
const settings = read('frontend/src/components/pages/settings.js');
const routes = read('frontend/src/components/page-handler.js');
const sidebar = read('frontend/src/components/sidebar.js');
const worker = read('cloudflare/license/src/index.js');
const migration = read('cloudflare/license/migrations/0008_analytics.sql');
const bootstrap = read('launcher/bootstrap.js');
const recorder = read('launcher/analytics-recorder.js');
const targetEngine = read('runtime-app/public/helpers/target-engine.js');

assert.match(routes, /path="\/dashboard"/);
assert.match(routes, /<Dashboard email=\{license\.email \|\| ''\}/);
assert.match(routes, /<Redirect to="\/dashboard"/);
assert.match(sidebar, /to: '\/dashboard', icon: 'activity', label: 'Dashboard'/);
for (const label of ['Today', 'Last 30 Days', 'Last 90 Days', 'All Time', 'Checkouts', 'Declines', 'Total Spent', 'Stuck In Cart']) {
  assert.match(dashboard, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}
assert.match(dashboard, /analyticsDashboard/);
assert.match(dashboard, /analyticsCheckouts/);
assert.doesNotMatch(dashboard, /deleteAnalytics/);
assert.match(settings, /ipcRenderer\.invoke\('deleteAnalytics'\)/);
assert.match(settings, /Permanently delete all analytics data/);
assert.match(settings, /This cannot be undone/);
assert.match(dashboard, /text\/csv/);
assert.match(dashboard, /<MetricChart/);
assert.match(dashboardCss, /--card-line: #e11d48/);
assert.match(dashboardCss, /--card-line: #f97316/);
assert.doesNotMatch(`${dashboard}\n${dashboardCss}`, /\bPolar\b/i);

assert.match(worker, /authenticatedLicense\(request, env\)/);
assert.match(worker, /\/api\/analytics\/events/);
assert.match(worker, /\/api\/analytics\/dashboard/);
assert.match(worker, /\/api\/analytics\/checkouts/);
assert.match(worker, /terminal\.event_type IN \('checkout', 'decline'\)/);
assert.match(migration, /PRIMARY KEY \(user_id, event_id\)/);
assert.match(migration, /FOREIGN KEY \(user_id\) REFERENCES users\(id\) ON DELETE CASCADE/);
assert.doesNotMatch(recorder, /cardNumber|shippingAddress|billingAddress|profileEmail/);
assert.match(recorder, /zyn-analytics:\$\{email\}/);
assert.match(recorder, /entry\.owner === owner/);
assert.match(bootstrap, /createAnalyticsService/);
assert.match(bootstrap, /bridgeRecorder\.setService\(service\)/);
assert.match(targetEngine, /case 'analytics-event':/);
assert.match(targetEngine, /analyticsRecorder\.record\(m\)/);

console.log(JSON.stringify({
  ok: true,
  dashboard: true,
  accountBoundOutbox: true,
  authenticatedD1: true,
  privacyFiltered: true,
}, null, 2));
