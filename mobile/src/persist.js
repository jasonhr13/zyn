import { NativeModules } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';

const native = requireOptionalNativeModule('ZynHarvester') || NativeModules.ZynHarvester || null;
const STATE_KEY = 'state';

function readRaw(key) {
  try {
    if (!native || typeof native.getItem !== 'function') return '';
    return String(native.getItem(key) || '');
  } catch {
    return '';
  }
}

function writeRaw(key, value) {
  try {
    if (!native || typeof native.setItem !== 'function') return;
    native.setItem(key, String(value || ''));
  } catch {}
}

export function loadPersistedState() {
  const raw = readRaw(STATE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function savePersistedState(state) {
  const payload = {
    pairingUrl: String(state && state.pairingUrl || ''),
    deviceId: String(state && state.deviceId || ''),
    selectedList: String(state && state.selectedList || ''),
    workers: Number(state && state.workers) || 1,
    lowData: state && state.lowData === true,
  };
  writeRaw(STATE_KEY, JSON.stringify(payload));
}
