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

function loadWindowSize(filePath, workAreaSize) {
  try {
    return normalizeWindowSize(JSON.parse(fs.readFileSync(filePath, 'utf8')), workAreaSize);
  } catch {
    return normalizeWindowSize(DEFAULT_WINDOW_SIZE, workAreaSize);
  }
}

function saveWindowSize(filePath, bounds) {
  const size = normalizeWindowSize(bounds);
  const tempPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tempPath, JSON.stringify({ version: 1, ...size }, null, 2), 'utf8');
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try { fs.unlinkSync(tempPath); } catch {}
    throw error;
  }
  return size;
}

module.exports = {
  DEFAULT_WINDOW_SIZE,
  MIN_WINDOW_SIZE,
  normalizeWindowSize,
  loadWindowSize,
  saveWindowSize,
};
