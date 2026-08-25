#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'frontend/src/components/virtual-list.js'), 'utf8');
const start = source.indexOf('export const TASK_ROW_HEIGHT');
const end = source.indexOf('export default class VirtualList');
assert.notEqual(start, -1, 'visibleListWindow is missing');
const sandbox = {};
vm.runInNewContext(`${source.slice(start, end)
  .replace(/export const/g, 'const')
  .replace('export function', 'function')}\nresult = visibleListWindow;`, sandbox);
const visibleListWindow = sandbox.result;

const empty = visibleListWindow({ count: 0 });
assert.equal(empty.start, 0);
assert.equal(empty.end, 0);
assert.equal(empty.padTop, 0);
assert.equal(empty.padBottom, 0);

const windowed = visibleListWindow({
  scrollTop: 460,
  viewportHeight: 460,
  count: 10000,
  rowHeight: 46,
  overscan: 8,
});
assert.equal(windowed.start, 2);
assert.equal(windowed.end, 28);
assert.equal(windowed.padTop, 92);
assert.equal(windowed.padBottom, (10000 - 28) * 46);
assert.ok(windowed.end - windowed.start < 40, 'a 10k list must only mount a short visible window');

const taskGroups = fs.readFileSync(path.join(root, 'frontend/src/components/pages/task-groups.js'), 'utf8');
const walmart = fs.readFileSync(path.join(root, 'frontend/src/components/pages/walmart.js'), 'utf8');
const pokemon = fs.readFileSync(path.join(root, 'frontend/src/components/pages/pokemoncenter.js'), 'utf8');
assert.match(taskGroups, /<VirtualList/);
assert.match(walmart, /<VirtualList/);
assert.match(pokemon, /<VirtualList/);
assert.match(taskGroups, /<InlineSelect/);
assert.match(walmart, /<InlineSelect/);
assert.match(pokemon, /<InlineSelect/);
assert.doesNotMatch(taskGroups, /visibleTasks\.map\(task => this\.renderTaskRow/);
assert.doesNotMatch(walmart, /walmart\.tasks\.map\(task =>/);
assert.doesNotMatch(pokemon, /pokemon\.tasks\.map\(task =>/);
assert.match(taskGroups, /persistTimer = setTimeout/);
assert.match(walmart, /setTimeout\(this\.flushPersist, 400\)/);
assert.match(pokemon, /setTimeout\(this\.flushPersist, 400\)/);
assert.match(walmart, /pickTableState\(state\.walmart/);
assert.match(pokemon, /pickTableState\(state\.pokemon/);
assert.match(walmart, /indexById\(loginAccounts\)/);
assert.match(pokemon, /indexById\(list\)/);
assert.doesNotMatch(walmart, /walmart: state\.walmart/);
assert.doesNotMatch(pokemon, /pokemon: state\.pokemon/);

const styles = fs.readFileSync(path.join(root, 'frontend/src/App.css'), 'utf8');
assert.match(styles, /\.virtual-list \{ overflow-x: hidden; overflow-y: auto/);
assert.match(styles, /\.group-task-virtual \{ max-height:/);
assert.match(styles, /\.site-task-virtual \{ max-height:/);
assert.doesNotMatch(styles, /\.group-task-virtual \{ height:/);
assert.doesNotMatch(styles, /\.site-task-virtual \{ height:/);
assert.match(styles, /\.inline-select-menu \{[\s\S]*z-index: 1100/);

const store = fs.readFileSync(path.join(root, 'launcher/task-group-store.js'), 'utf8');
assert.match(store, /JSON\.stringify\(value\)/);
assert.doesNotMatch(store, /JSON\.stringify\(value, null, 2\)/);

console.log(JSON.stringify({ ok: true, windowed }, null, 2));
