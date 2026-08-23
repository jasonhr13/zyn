export const PROFILES_WORKSPACE_KEY = 'zyn.profiles.workspace';
export const ACCOUNTS_WORKSPACE_KEY = 'zyn.accounts.workspace';

const emptySelection = () => ({ activeGroup: '', query: '', selected: [], accountSite: '' });

function sanitizedAccountSite(value) {
  const site = String(value || '').trim().toLowerCase();
  return site === 'walmart' || site === 'target' ? site : '';
}

function sanitizedSelected(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const selected = [];
  for (const item of value) {
    const id = String(item || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    selected.push(id);
    if (selected.length >= 500) break;
  }
  return selected;
}

export function readWorkspaceSelection(storageKey) {
  try {
    const raw = JSON.parse(window.localStorage.getItem(storageKey) || 'null');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptySelection();
    return {
      activeGroup: typeof raw.activeGroup === 'string' ? raw.activeGroup : '',
      query: typeof raw.query === 'string' ? raw.query : '',
      selected: sanitizedSelected(raw.selected),
      accountSite: sanitizedAccountSite(raw.accountSite),
    };
  } catch {
    return emptySelection();
  }
}

export function writeWorkspaceSelection(storageKey, { activeGroup, query, selected, accountSite } = {}) {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify({
      activeGroup: String(activeGroup || ''),
      query: String(query || ''),
      selected: sanitizedSelected(selected),
      accountSite: sanitizedAccountSite(accountSite),
    }));
  } catch {}
}
