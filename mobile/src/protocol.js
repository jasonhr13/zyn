function parsePairingInput(value) {
  const text = String(value || '').trim().replace(/^['"]+|['"]+$/g, '');
  if (!text) return null;
  const embedded = text.match(/zyn:\/\/[^\s"'<>]+/i);
  const candidate = embedded ? embedded[0] : text;
  try {
    const url = new URL(candidate);
    if (url.protocol === 'zyn:') {
      const roomId = url.searchParams.get('room') || '';
      const joinToken = url.searchParams.get('token') || '';
      const origin = url.searchParams.get('origin') || 'https://license.zynbot.app';
      if (!roomId || !joinToken) return null;
      return { roomId, joinToken, origin };
    }
  } catch {}
  return null;
}

function websocketUrl({ origin, roomId, joinToken, deviceId }) {
  const url = new URL('/api/mobile/ws', origin);
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  url.searchParams.set('room', roomId);
  url.searchParams.set('role', 'phone');
  url.searchParams.set('token', joinToken);
  url.searchParams.set('deviceId', deviceId);
  return url.toString();
}

function flattenProxyGroups(groups = {}) {
  const lines = [];
  for (const list of Object.values(groups || {})) {
    if (!Array.isArray(list)) continue;
    for (const line of list) {
      const value = String(line || '').trim();
      if (value) lines.push(value);
    }
  }
  return lines;
}

function normalizeProxyGroups(groups = {}, lists = []) {
  return mergeProxyGroups([], { groups, lists });
}

function mergeProxyGroups(current = [], message = {}) {
  const next = new Map();
  for (const group of current || []) {
    if (!group || !group.name) continue;
    next.set(group.name, {
      name: group.name,
      lines: Array.isArray(group.lines) ? group.lines : [],
      count: Number(group.count) || 0,
    });
  }
  for (const item of message.lists || []) {
    const name = String(item && item.name || '').trim().slice(0, 80);
    if (!name) continue;
    const prev = next.get(name) || { name, lines: [], count: 0 };
    next.set(name, {
      name,
      lines: prev.lines,
      count: Math.max(prev.count, Number(item.count) || 0, prev.lines.length),
    });
  }
  for (const [name, list] of Object.entries(message.groups || {})) {
    const label = String(name || '').trim().slice(0, 80);
    if (!label || !Array.isArray(list)) continue;
    const lines = [];
    for (const line of list) {
      const value = String(line || '').trim();
      if (value) lines.push(value);
    }
    if (!lines.length) continue;
    const prev = next.get(label) || { name: label, lines: [], count: 0 };
    next.set(label, {
      name: label,
      lines,
      count: Math.max(prev.count, lines.length),
    });
  }
  return [...next.values()];
}

function desktopOnlineFrom(message) {
  if (!message || typeof message !== 'object') return null;
  if (message.desktopOnline === true || (message.peer && message.peer.desktopOnline === true)) return true;
  if (message.desktopOnline === false || (message.peer && message.peer.desktopOnline === false)) return false;
  return null;
}

function selectedProxyLines(groups = [], selectedNames = []) {
  const allowed = new Set((selectedNames || []).map((name) => String(name)));
  const lines = [];
  for (const group of groups || []) {
    if (!group || !allowed.has(group.name) || !Array.isArray(group.lines)) continue;
    for (const line of group.lines) {
      const value = String(line || '').trim();
      if (value) lines.push(value);
    }
  }
  return lines;
}

function clampWorkers(value) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, Math.min(6, parsed));
}

function proxyToUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.includes('://') || text.includes('@')) {
    return text.includes('://') ? text : `http://${text}`;
  }
  const parts = text.split(':');
  if (parts.length >= 4) {
    const host = parts[0];
    const port = parts[1];
    const user = parts[2];
    const pass = parts.slice(3).join(':');
    return `http://${user}:${pass}@${host}:${port}`;
  }
  if (parts.length >= 2) return `http://${parts[0]}:${parts[1]}`;
  return text;
}

module.exports = {
  parsePairingInput,
  websocketUrl,
  flattenProxyGroups,
  normalizeProxyGroups,
  mergeProxyGroups,
  selectedProxyLines,
  clampWorkers,
  desktopOnlineFrom,
  proxyToUrl,
};
