#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const project = path.resolve(__dirname, '..');
const taskGroups = fs.readFileSync(
  path.join(project, 'frontend', 'src', 'components', 'pages', 'task-groups.js'),
  'utf8',
);
const taskRuntime = fs.readFileSync(
  path.join(project, 'frontend', 'src', 'components', 'target-task-runtime.js'),
  'utf8',
);
const styles = fs.readFileSync(path.join(project, 'frontend', 'src', 'App.css'), 'utf8');
const bankMetrics = fs.readFileSync(
  path.join(project, 'frontend', 'src', 'components', 'target-bank-metrics.mjs'),
  'utf8',
);

assert.match(taskGroups, /selectedTaskId: ''/);
assert.match(taskGroups, /renderTaskDetail\(group, task\)/);
assert.match(taskGroups, /className=\{`group-task-row group-task-row-clickable\$\{selected \? ' selected' : ''\}`\}/);
assert.match(taskGroups, /toggleSelectVisibleTasks/);
assert.match(taskGroups, /renderGroupDropPulse/);
assert.match(taskGroups, /renderProxySelectOptions/);
assert.match(taskGroups, /Folders/);
assert.match(taskRuntime, /summarizeGroupDropPulse/);
assert.match(taskGroups, /Adding to cart/);
assert.match(taskGroups, /Carted this run/);
assert.match(taskGroups, /Successful checkouts this run/);
assert.match(taskGroups, /Failed this run/);
assert.match(styles, /\.group-drop-pulse/);
assert.match(styles, /\.group-drop-stat-submit\.active/);
assert.match(styles, /\.group-drop-stat-fail\.active/);
assert.match(styles, /\.target-task-status-watching \{ color: var\(--target-status-watch\)/);
assert.doesNotMatch(styles, /\.target-task-status-idle,\s*\.target-task-status-watching/);
assert.match(taskGroups, /updateTasksProxy/);
assert.match(taskGroups, /Set proxy/);
assert.match(taskGroups, /Select all visible tasks/);
assert.match(taskGroups, /setSkuPriority/);
assert.match(taskGroups, /watchListSummary/);
assert.match(taskGroups, /Mark as priority/);
assert.match(taskGroups, /addWatchedSkus/);
assert.match(taskGroups, /removeSku/);
assert.match(taskGroups, /aria-label=\{`Remove Target SKU \$\{sku\}`\}/);
assert.doesNotMatch(taskGroups, /group-sku-input/);
assert.match(styles, /\.target-sku-priority/);
assert.match(styles, /\.target-sku-watch-row/);
assert.match(styles, /\.target-sku-remove/);
assert.match(styles, /\.group-task-bulk-bar/);
assert.match(taskGroups, /openTask = task => this\.setState\(\{ selectedTaskId: task\.id/);
assert.match(taskGroups, /host\.openTask\(task\)/);
assert.match(taskGroups, /this\.props\.taskLogs/);
assert.match(taskGroups, /only this task/);
assert.match(taskGroups, /Broker, farmer, and monitor startup remain in the shared log below/);
assert.match(taskGroups, /<SharedEngineLog/);
assert.match(taskGroups, /renderSharedEngineLog\(source = this\.props\)/);
assert.match(taskGroups, /<VirtualLogView/);
assert.match(taskGroups, /showOperatorLogs/);
assert.match(taskGroups, /<GroupMonitorStatus/);
assert.match(styles, /\.group-ops-monitor-watching/);
assert.match(styles, /\.task-log-view-virtual/);
assert.match(styles, /\.task-log-virtual-pad/);
assert.match(taskGroups, /this\.renderHarvesterDrawer\(\)/);
assert.match(taskGroups, /aria-label="Close Cookie Harvesters"/);
assert.match(bankMetrics, /Opening the shared cookie bank/);
assert.doesNotMatch(taskGroups, /Wine, Windows Node, and the cookie broker are starting/);
assert.doesNotMatch(taskGroups, /\|\| 'Auto'/);
assert.doesNotMatch(taskGroups, /R2 groups existing Target controls only/);
assert.match(styles, /\.group-task-row-clickable:focus-visible/);
assert.match(styles, /\.cookie-bank-starting/);
assert.match(styles, /\.cookie-bank-error/);
assert.match(styles, /\.cookie-bank-stopped/);
assert.match(styles, /\.cookie-bank-broker/);
assert.doesNotMatch(styles, /\.cookie-bank-health/);
assert.match(styles, /\.tasks-workspace-with-harvester-dock/);
assert.match(styles, /\.target-harvester-drawer-layer/);

console.log('Target task-group detail and broker-startup smoke test passed');
