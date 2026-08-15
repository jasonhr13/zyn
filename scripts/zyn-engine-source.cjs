'use strict';

const path = require('path');

const projectRoot = path.resolve(__dirname, '..');

function engineSourceRoot() {
  const override = process.env.ZYN_ENGINE_SOURCE || process.env.POLAR_BACKEND_SOURCE;
  return override ? path.resolve(override) : path.join(projectRoot, 'engine');
}

module.exports = { engineSourceRoot, projectRoot };
