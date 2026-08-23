'use strict';

// The archived Electron main process registers these listeners after the wrapper has initialized.
// Intercept registration so a renderer cannot bypass a hidden route and reach the old handler.
const OPTIONAL_START_CHANNELS = Object.freeze({
  startPokemonCenter: 'pokemoncenter',
  startWalmart: 'walmart',
  startRound1: 'round1',
});

function installTaskTypeIpcGuard({ ipcMain, authority, onBlocked = () => {} } = {}) {
  if (!ipcMain || typeof ipcMain.on !== 'function') throw new Error('ipcMain.on is required');
  if (!authority || typeof authority.cached !== 'function') throw new Error('license authority is required');

  const originalOn = ipcMain.on;
  function guardedOn(channel, listener) {
    const taskType = OPTIONAL_START_CHANNELS[channel];
    if (!taskType || typeof listener !== 'function') {
      return originalOn.call(this, channel, listener);
    }
    return originalOn.call(this, channel, function guardedTaskTypeListener(event, ...args) {
      const status = authority.cached() || {};
      // Let the archived handler produce its established unlicensed response. This guard owns only
      // the second authorization layer: an otherwise-valid account without this optional module.
      if (status.ok === true && status.taskTypes?.[taskType] !== true) {
        if (event) event.returnValue = false;
        onBlocked({ channel, taskType, status });
        return undefined;
      }
      return listener.call(this, event, ...args);
    });
  }

  ipcMain.on = guardedOn;
  return () => {
    if (ipcMain.on === guardedOn) ipcMain.on = originalOn;
  };
}

module.exports = { OPTIONAL_START_CHANNELS, installTaskTypeIpcGuard };
