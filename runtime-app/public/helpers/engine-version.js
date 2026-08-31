'use strict';

function displayEngineVersion(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  const match = value.match(/^(\d+\.\d+\.\d+)(?:-[0-9a-f]{8,})?$/i);
  return match ? match[1] : value;
}

function engineInfoFrom({ runningRaw = '', installedRaw = '', engineRunning = false } = {}) {
  const installed = displayEngineVersion(installedRaw);
  const running = engineRunning
    ? (displayEngineVersion(runningRaw) || installed)
    : (installed || displayEngineVersion(runningRaw));
  const pendingRestart = Boolean(
    engineRunning && running && installed && running !== installed,
  );
  return {
    running: running || '',
    installed: installed || running || '',
    runningFull: String(runningRaw || ''),
    installedFull: String(installedRaw || ''),
    pendingRestart,
  };
}

module.exports = { displayEngineVersion, engineInfoFrom };
