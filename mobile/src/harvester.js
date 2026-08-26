import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';
import protocol from './protocol';

const ZynHarvester =
  requireOptionalNativeModule('ZynHarvester') || NativeModules.ZynHarvester || null;
const isExpoModule = Boolean(ZynHarvester && ZynHarvester.__expo_module_name__);
const emitter = ZynHarvester && !isExpoModule ? new NativeEventEmitter(ZynHarvester) : null;

export function isHarvesterAvailable() {
  return Boolean(ZynHarvester);
}

export function getMaxWindows() {
  if (Platform.OS !== 'ios') return 1;
  const n = Number(ZynHarvester && ZynHarvester.maxWindows);
  if (!Number.isFinite(n) || n < 1) return 6;
  return Math.max(1, Math.min(6, Math.floor(n)));
}

export function startHarvester({ proxies, site = 'target', lowData = false, workers = 1 } = {}) {
  if (!ZynHarvester) throw new Error('Harvester is not available on this device');
  const max = getMaxWindows();
  const count = Math.max(1, Math.min(max, Number.parseInt(String(workers), 10) || 1));
  const lines = (proxies || []).map((line) => protocol.proxyToUrl(line)).filter(Boolean);
  ZynHarvester.start(lines, site, lowData === true, count);
}

export function stopHarvester() {
  if (ZynHarvester) ZynHarvester.stop();
}

export function addHarvesterListener(event, handler) {
  if (!ZynHarvester) return { remove() {} };
  if (isExpoModule && typeof ZynHarvester.addListener === 'function') {
    return ZynHarvester.addListener(event, handler);
  }
  if (!emitter) return { remove() {} };
  return emitter.addListener(event, handler);
}
