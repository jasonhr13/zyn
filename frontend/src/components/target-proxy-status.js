// The checkout engine reports live proxy edits through the same update-status channel as real task
// steps. Keep these messages transient so "Switched To …" cannot replace a long-lived state such as
// "Watching for restock" (or make a running task look stopped after a switch failure).
export function isTargetProxyStatus(value) {
  const text = String(value || '').trim();
  return /^(?:Switched To .+|Could Not Switch To .+|Could Not Clear Proxy|Switch To .+ \(applies after carting\))$/i.test(text);
}

export function isQueuedTargetProxyStatus(value) {
  return /\(applies after carting\)$/i.test(String(value || '').trim());
}

export function isTargetProxyStatusForGroup(value, group) {
  const text = String(value || '').trim().toLowerCase();
  const expected = String(group || '').trim().toLowerCase() || 'local';
  if (!isTargetProxyStatus(text)) return false;
  if (expected === 'local') {
    return text === 'could not clear proxy'
      || text === 'switched to local (home ip)'
      || text === 'switch to local (applies after carting)';
  }
  return text === `switched to ${expected}`
    || text === `could not switch to ${expected}`
    || text === `switch to ${expected} (applies after carting)`;
}
