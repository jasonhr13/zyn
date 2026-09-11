'use strict';

const fs = require('fs');
const path = require('path');

const DISABLE_GPU_MARKER = 'disable-gpu';

function envWantsSoftwareGpu(env = process.env) {
  const raw = String((env && env.ZYN_DISABLE_GPU) || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function disableGpuMarkerPath(userData) {
  return path.join(String(userData || ''), DISABLE_GPU_MARKER);
}

function markerWantsSoftwareGpu(userData, existsSync = fs.existsSync) {
  if (!userData) return false;
  try { return existsSync(disableGpuMarkerPath(userData)) === true; }
  catch { return false; }
}

function softwareGpuRequested({
  env = process.env,
  userData = '',
  existsSync = fs.existsSync,
} = {}) {
  if (envWantsSoftwareGpu(env)) return 'env';
  if (markerWantsSoftwareGpu(userData, existsSync)) return 'file';
  return '';
}

function writeSoftwareGpuMarker(userData, enabled, {
  writeFileSync = fs.writeFileSync,
  unlinkSync = fs.unlinkSync,
  mkdirSync = fs.mkdirSync,
} = {}) {
  if (!userData) throw new Error('userData is required to persist GPU compositing.');
  mkdirSync(userData, { recursive: true });
  const file = disableGpuMarkerPath(userData);
  if (enabled) {
    writeFileSync(file, '1\n', { encoding: 'utf8' });
    return file;
  }
  try { unlinkSync(file); } catch (error) {
    if (error && error.code !== 'ENOENT') throw error;
  }
  return file;
}

function gpuFeatureSnapshot(app) {
  try {
    if (!app || typeof app.getGPUFeatureStatus !== 'function') return null;
    const status = app.getGPUFeatureStatus();
    return status && typeof status === 'object' ? status : null;
  } catch {
    return null;
  }
}

function compositingLabel(status) {
  const value = String((status && (status.gpu_compositing || status.gpuCompositing)) || '').toLowerCase();
  if (!value) return '';
  if (value.includes('disabled') || value.includes('software')) return 'software';
  if (value.includes('enabled')) return 'hardware';
  return value;
}

function preserveHardwareAcceleration(app, {
  platform = process.platform,
  env = process.env,
  userData = '',
  existsSync = fs.existsSync,
  log = console,
} = {}) {
  const reason = softwareGpuRequested({ env, userData, existsSync });
  if (reason) {
    log.info?.(`Zyn GPU compositing: software (${reason === 'env' ? 'ZYN_DISABLE_GPU' : 'userData/disable-gpu'}).`);
    return { allowed: false, reason };
  }
  if (platform !== 'darwin' && platform !== 'win32') {
    return { allowed: false, reason: 'platform' };
  }
  app.disableHardwareAcceleration = () => {};
  log.info?.('Zyn GPU compositing: hardware. Chromium may still use software if this session has no GPU.');
  return { allowed: true, reason: '' };
}

function installGpuCompositing({
  app,
  ipcMain,
  platform = process.platform,
  env = process.env,
  log = console,
} = {}) {
  if (!app || !ipcMain) throw new Error('app and ipcMain are required');
  const userData = app.getPath('userData');
  const session = preserveHardwareAcceleration(app, { platform, env, userData, log });

  const snapshot = () => {
    const requested = softwareGpuRequested({ env, userData });
    return {
      platform,
      softwareForced: requested === 'env' || requested === 'file',
      softwareForcedBy: requested === 'env' || requested === 'file' ? requested : '',
      allowed: session.allowed === true,
      compositing: compositingLabel(gpuFeatureSnapshot(app)),
      gpu: gpuFeatureSnapshot(app),
      restartRequired: Boolean(requested) !== Boolean(session.reason && session.reason !== 'platform'),
    };
  };

  const logStatus = () => {
    const current = snapshot();
    log.info?.(`Zyn GPU feature status: compositing=${current.compositing || 'unknown'} ${JSON.stringify(current.gpu || {})}`);
  };

  try { ipcMain.removeHandler('gpuCompositing'); } catch {}
  try { ipcMain.removeHandler('setSoftwareGpu'); } catch {}
  ipcMain.handle('gpuCompositing', () => snapshot());
  ipcMain.handle('setSoftwareGpu', (_event, enabled) => {
    writeSoftwareGpuMarker(userData, enabled === true);
    return snapshot();
  });

  app.whenReady().then(() => {
    logStatus();
  }).catch((error) => {
    log.warn?.(`Zyn GPU feature status unavailable: ${error.message}`);
  });
  app.on('child-process-gone', (_event, details) => {
    const type = String((details && details.type) || '');
    if (type !== 'GPU' && type !== 'GPU (none)') return;
    log.error?.(`Zyn GPU process gone: ${details && details.reason} exit=${details && details.exitCode}`);
  });

  return snapshot;
}

module.exports = {
  DISABLE_GPU_MARKER,
  disableGpuMarkerPath,
  softwareGpuRequested,
  writeSoftwareGpuMarker,
  preserveHardwareAcceleration,
  gpuFeatureSnapshot,
  compositingLabel,
  installGpuCompositing,
};
