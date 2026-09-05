const fs = require('fs');
const path = require('path');

const DEFAULT_WINDOW_SIZE = Object.freeze({ width: 1100, height: 700 });
const MIN_WINDOW_SIZE = Object.freeze({ width: 900, height: 600 });

function finiteDimension(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : fallback;
}

function normalizeWindowSize(value, workAreaSize = {}) {
  const raw = value && typeof value === 'object' ? value : {};
  const maxWidth = Math.max(
    MIN_WINDOW_SIZE.width,
    finiteDimension(workAreaSize.width, Number.MAX_SAFE_INTEGER),
  );
  const maxHeight = Math.max(
    MIN_WINDOW_SIZE.height,
    finiteDimension(workAreaSize.height, Number.MAX_SAFE_INTEGER),
  );
  const width = finiteDimension(raw.width, DEFAULT_WINDOW_SIZE.width);
  const height = finiteDimension(raw.height, DEFAULT_WINDOW_SIZE.height);

  return {
    width: Math.min(maxWidth, Math.max(MIN_WINDOW_SIZE.width, width)),
    height: Math.min(maxHeight, Math.max(MIN_WINDOW_SIZE.height, height)),
  };
}

function hasPosition(value) {
  return value && ['x', 'y'].every(key => typeof value[key] === 'number'
    && Number.isSafeInteger(Math.round(value[key])));
}

function normalizeWindowBounds(value, displays, primaryDisplay) {
  const raw = value && typeof value === 'object' ? value : {};
  const savedSize = normalizeWindowSize(raw);
  let display = primaryDisplay || displays[0];
  let overlap = 0;

  if (hasPosition(raw)) {
    // Coordinates are desktop-wide and can be negative on monitors left of or above the primary.
    for (const candidate of displays) {
      const area = candidate.workArea;
      const width = Math.max(0, Math.min(raw.x + savedSize.width, area.x + area.width) - Math.max(raw.x, area.x));
      const height = Math.max(0, Math.min(raw.y + savedSize.height, area.y + area.height) - Math.max(raw.y, area.y));
      if (width * height > overlap) {
        overlap = width * height;
        display = candidate;
      }
    }
  }

  const area = display.workArea;
  const size = normalizeWindowSize(raw, area);
  const maxX = area.x + Math.max(0, area.width - size.width);
  const maxY = area.y + Math.max(0, area.height - size.height);
  return {
    ...size,
    x: Math.round(overlap ? Math.min(maxX, Math.max(area.x, raw.x)) : (area.x + maxX) / 2),
    y: Math.round(overlap ? Math.min(maxY, Math.max(area.y, raw.y)) : (area.y + maxY) / 2),
  };
}

function loadWindowBounds(filePath, displays, primaryDisplay) {
  let saved = null;
  try {
    saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {}
  return normalizeWindowBounds(saved, displays, primaryDisplay);
}

function saveWindowBounds(filePath, bounds) {
  const state = {
    ...normalizeWindowSize(bounds),
    ...(hasPosition(bounds) ? { x: Math.round(bounds.x), y: Math.round(bounds.y) } : {}),
  };
  const tempPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tempPath, JSON.stringify({ version: 2, ...state }, null, 2), 'utf8');
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try { fs.unlinkSync(tempPath); } catch {}
    throw error;
  }
  return state;
}

function installWindowStatePersistence({ app, screen, statePath, log = console }) {
  let primaryWindow = null;
  // The original main process creates the main window hidden. Restore before its first paint;
  // leave child windows alone, and attach again when macOS recreates the closed main window.
  app.on('browser-window-created', (_event, window) => {
    if (primaryWindow || window.getParentWindow()) return;
    primaryWindow = window;
    let saveTimer = null;
    const persist = () => {
      if (window.isDestroyed()) return;
      try {
        saveWindowBounds(statePath, window.getNormalBounds());
      } catch (error) {
        log.error(`Could not save Zyn window position: ${error.message}`);
      }
    };
    const scheduleSave = () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(persist, 250);
    };
    window.once('closed', () => {
      clearTimeout(saveTimer);
      primaryWindow = null;
    });
    try {
      const bounds = loadWindowBounds(statePath, screen.getAllDisplays(), screen.getPrimaryDisplay());
      window.setMinimumSize(MIN_WINDOW_SIZE.width, MIN_WINDOW_SIZE.height);
      window.setBounds(bounds, false);
      window.on('move', scheduleSave);
      window.on('resize', scheduleSave);
      window.once('close', () => {
        clearTimeout(saveTimer);
        persist();
      });
    } catch (error) {
      log.error(`Could not restore Zyn window position: ${error.message}`);
    }
  });
}

module.exports = {
  DEFAULT_WINDOW_SIZE,
  MIN_WINDOW_SIZE,
  normalizeWindowSize,
  normalizeWindowBounds,
  loadWindowBounds,
  saveWindowBounds,
  installWindowStatePersistence,
};
