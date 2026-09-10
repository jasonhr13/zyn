'use strict';

const Module = require('module');
const path = require('path');

const webModules = path.join(__dirname, '..', 'node_modules');
const parts = String(process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean);
if (!parts.includes(webModules)) {
  process.env.NODE_PATH = [webModules, ...parts].join(path.delimiter);
  Module._initPaths();
}
