import { connect } from 'react-redux';
import VirtualLogView from './virtual-log-view';

const EMPTY_LINES = Object.freeze([]);
const tableCaches = new WeakMap();

export function pickTableState(source, keys) {
  const previous = tableCaches.get(keys);
  if (previous && keys.every(key => previous[key] === source[key])) return previous;
  const next = {};
  for (const key of keys) next[key] = source[key];
  tableCaches.set(keys, next);
  return next;
}

export function indexById(list) {
  const map = new Map();
  for (const item of list || []) {
    if (item && item.id != null) map.set(String(item.id), item);
  }
  return map;
}

export function indexByEmail(list) {
  const map = new Map();
  for (const item of list || []) {
    const email = String((item && item.email) || '').trim().toLowerCase();
    if (email && !map.has(email)) map.set(email, item);
  }
  return map;
}

export function connectEngineLog(moduleKey) {
  return connect(state => ({
    lines: (state[moduleKey] && state[moduleKey].logs) || EMPTY_LINES,
  }))(VirtualLogView);
}

export function connectTaskLog(moduleKey) {
  return connect((state, { taskId }) => ({
    lines: (((state[moduleKey] && state[moduleKey].taskLogs) || {})[taskId]) || EMPTY_LINES,
  }))(VirtualLogView);
}
