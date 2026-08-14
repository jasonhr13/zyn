export const proxyRef = (list) => String((list && (list.ref || list.name)) || '');

export const proxyName = (list) => String((list && (list.label || list.name)) || '');

export const proxyLabel = (list) => {
  const name = proxyName(list);
  return list && list.managed ? `${name} · Managed` : name;
};

export const proxyCount = (list) => {
  if (!list) return 0;
  if (Number.isFinite(Number(list.count))) return Number(list.count);
  return String(list.raw || '').split('\n').filter(line => line.trim()).length;
};

export const proxyFolderRef = name => {
  const text = String(name || '').trim();
  return text ? `group:${text}` : '';
};

export const proxyFolderName = ref => {
  const value = String(ref || '').trim();
  return value.toLowerCase().startsWith('group:') ? value.slice(6).trim() : '';
};

export const proxyLabelForRef = (lists, ref, fallback = '') => {
  const value = String(ref || '');
  if (!value) return fallback;
  const folder = proxyFolderName(value);
  if (folder) return folder;
  const match = (Array.isArray(lists) ? lists : []).find(list => proxyRef(list) === value);
  if (match) return proxyLabel(match);
  return value.startsWith('managed:') ? 'Managed proxy unavailable' : value;
};
