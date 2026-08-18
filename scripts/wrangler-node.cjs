'use strict';

const fs = require('fs');
const path = require('path');

function nodeMajor(version) {
  return Number(String(version || '').replace(/^v/, '').split('.')[0]) || 0;
}

function wranglerNode() {
  if (nodeMajor(process.versions.node) >= 22) return process.execPath;
  const home = process.env.HOME || '';
  const nvmRoot = process.env.NVM_DIR || path.join(home, '.nvm');
  const versionsDir = path.join(nvmRoot, 'versions', 'node');
  let bestName = '';
  try {
    for (const name of fs.readdirSync(versionsDir)) {
      if (nodeMajor(name) < 22) continue;
      if (!bestName || name.localeCompare(bestName, undefined, { numeric: true }) > 0) {
        bestName = name;
      }
    }
  } catch {}
  if (bestName) {
    const bin = path.join(versionsDir, bestName, 'bin', 'node');
    if (fs.existsSync(bin)) return bin;
  }
  throw new Error(
    'Wrangler needs Node.js 22+. This shell is on '
    + process.versions.node
    + '. Run `nvm use 22` or install Node 22, then rerun.',
  );
}

module.exports = { wranglerNode };
