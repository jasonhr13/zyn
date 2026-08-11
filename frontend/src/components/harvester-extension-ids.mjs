export const MAX_HARVESTER_EXTENSION_IDS = 16;

export function parseHarvesterExtensionIds(value, { requireOne = false } = {}) {
  const entries = [];
  String(value || '').toLowerCase().split(/\r?\n/).forEach((line, lineIndex) => {
    line.split(/[\s,;]+/).filter(Boolean).forEach(id => entries.push({ id, line: lineIndex + 1 }));
  });

  const invalidLines = [...new Set(entries
    .filter(entry => !/^[a-p]{32}$/.test(entry.id))
    .map(entry => entry.line))];
  const ids = [...new Set(entries
    .filter(entry => /^[a-p]{32}$/.test(entry.id))
    .map(entry => entry.id))];

  let error = '';
  if (invalidLines.length) {
    error = `Invalid extension ID on line${invalidLines.length === 1 ? '' : 's'} ${invalidLines.join(', ')}. Each ID must contain exactly 32 letters from a–p.`;
  } else if (ids.length > MAX_HARVESTER_EXTENSION_IDS) {
    error = `Add no more than ${MAX_HARVESTER_EXTENSION_IDS} browser extension IDs.`;
  } else if (requireOne && !ids.length) {
    error = 'Add at least one browser extension ID before enabling extension harvesting.';
  }

  return { ids, error, normalized: ids.slice(0, MAX_HARVESTER_EXTENSION_IDS).join('\n') };
}

export function normalizeHarvesterExtensionIds(value) {
  return parseHarvesterExtensionIds(value).normalized;
}

export function harvesterExtensionIdsFromSettings(settings = {}) {
  return normalizeHarvesterExtensionIds([
    settings.targetHarvesterExtensionIds,
    settings.targetHarvesterExtensionId,
  ].filter(Boolean).join('\n'));
}

export function hasHarvesterExtensionId(value) {
  return parseHarvesterExtensionIds(value).ids.length > 0;
}
