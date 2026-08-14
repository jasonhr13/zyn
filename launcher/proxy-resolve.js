'use strict';

const GROUP_PREFIX = 'group:';

function normalizeGroups(values) {
  return (Array.isArray(values) ? values : []).map(value => String(value || '').trim()).filter(Boolean);
}

function groupsForList(list) {
  return normalizeGroups([
    ...(Array.isArray(list && list.groups) ? list.groups : []),
    list && list.group,
  ]);
}

function parseProxyRef(ref) {
  const value = String(ref || '').trim();
  if (!value || /^local$/i.test(value)) return { kind: 'local', label: 'Local', name: '' };
  if (value.toLowerCase().startsWith(GROUP_PREFIX)) {
    const name = value.slice(GROUP_PREFIX.length).trim();
    return { kind: 'group', label: name || 'Folder', name };
  }
  return { kind: 'list', label: value, name: value };
}

function groupRef(name) {
  const text = String(name || '').trim();
  return text ? `${GROUP_PREFIX}${text}` : '';
}

function linesOf(name, getProxyLines) {
  if (!name || typeof getProxyLines !== 'function') return [];
  try {
    return (getProxyLines(name) || []).map(line => String(line || '').trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function listsInFolder(folderName, getProxies) {
  const wanted = String(folderName || '').trim().toLowerCase();
  if (!wanted || typeof getProxies !== 'function') return [];
  let data = { lists: [] };
  try { data = getProxies() || { lists: [] }; } catch { data = { lists: [] }; }
  return (Array.isArray(data.lists) ? data.lists : []).filter(list => (
    list && !list.managed && groupsForList(list).some(group => group.toLowerCase() === wanted)
  ));
}

function resolveProxyAssignment(ref, { getProxyLines, getProxies } = {}) {
  const parsed = parseProxyRef(ref);
  if (parsed.kind === 'local') return { ...parsed, sources: [] };
  if (parsed.kind === 'list') {
    const lines = linesOf(parsed.name, getProxyLines);
    return { ...parsed, sources: lines.length ? [{ name: parsed.name, lines }] : [] };
  }
  if (!parsed.name) return { ...parsed, sources: [] };
  const sources = listsInFolder(parsed.name, getProxies).flatMap(list => {
    const name = String(list.name || '').trim();
    if (!name) return [];
    const lines = linesOf(name, getProxyLines);
    return lines.length ? [{ name, lines }] : [];
  });
  return { ...parsed, sources };
}

function assignmentLineCount(resolved) {
  return (resolved && Array.isArray(resolved.sources) ? resolved.sources : [])
    .reduce((sum, source) => sum + ((source.lines || []).length), 0);
}

function assignmentHasLines(resolved) {
  return !resolved || resolved.kind === 'local' || assignmentLineCount(resolved) > 0;
}

function displayProxyGroup(ref) {
  const parsed = parseProxyRef(ref);
  return parsed.kind === 'local' ? 'Local' : parsed.label;
}

module.exports = {
  GROUP_PREFIX,
  parseProxyRef,
  groupRef,
  resolveProxyAssignment,
  assignmentLineCount,
  assignmentHasLines,
  displayProxyGroup,
  listsInFolder,
  groupsForList,
};
