import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function normalizeHarvesterEngine(value) {
  return String(value || '').trim().toLowerCase() === 'patchright' ? 'patchright' : 'playwright';
}

export function harvesterWorkerMaximum({ type, engine, proxyListName } = {}) {
  if (type === 'login') return 1;
  if (normalizeHarvesterEngine(engine) === 'patchright') return proxyListName ? 8 : 2;
  return proxyListName ? 100 : 2;
}

export function harvestSourceForEngine(engine, fallback = 'inBot') {
  return normalizeHarvesterEngine(engine) === 'patchright' ? 'patchright' : fallback;
}

export function workerProfileDir(profileRoot, harvesterId, workerId) {
  const root = String(profileRoot || '').trim()
    || path.join(os.tmpdir(), 'zyn-shape-patchright', String(harvesterId || 'harvester'));
  return path.join(root, `w${workerId}`);
}

export async function loadHarvestChromium(engine) {
  if (normalizeHarvesterEngine(engine) === 'patchright') {
    const mod = await import('patchright');
    return mod.chromium;
  }
  const mod = await import('playwright');
  return mod.chromium;
}

export function ensureProfileDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
