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
const styles = fs.readFileSync(path.join(project, 'frontend', 'src', 'App.css'), 'utf8');

assert.match(taskGroups, /selectedTaskId: ''/);
assert.match(taskGroups, /renderTaskDetail\(group, task\)/);
assert.match(taskGroups, /className="group-task-row group-task-row-clickable"/);
assert.match(taskGroups, /onClick=\{\(\) => this\.setState\(\{ selectedTaskId: task\.id/);
assert.match(taskGroups, /\(this\.props\.target \|\| \{\}\)\.taskLogs/);
assert.match(taskGroups, /only this task/);
assert.match(taskGroups, /Broker, farmer, and monitor startup remain in the shared log below/);
assert.match(taskGroups, /this\.renderSharedEngineLog\(\)/);
assert.match(taskGroups, /The native cookie broker is starting/);
assert.doesNotMatch(taskGroups, /Wine, Windows Node, and the cookie broker are starting/);
assert.doesNotMatch(taskGroups, /\|\| 'Auto'/);
assert.doesNotMatch(taskGroups, /R2 groups existing Target controls only/);
assert.match(styles, /\.group-task-row-clickable:focus-visible/);
assert.match(styles, /\.cookie-bank-starting/);
assert.match(styles, /\.cookie-bank-error/);

console.log('Target task-group detail and broker-startup smoke test passed');
