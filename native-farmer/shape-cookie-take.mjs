'use strict';

export function isExtensionHarvestSource(source) {
  return String(source || '').trim().toLowerCase() === 'extension';
}

// ATC checkout prefers an extension-minted cookie when any are in the bank. Login and an empty
// extension set stay FIFO so a waiting task still takes the next available cookie.
export function takePreferredCookie(list, type) {
  if (!Array.isArray(list) || !list.length) return null;
  if (String(type || '').toLowerCase() === 'atc') {
    const index = list.findIndex(cookie => isExtensionHarvestSource(cookie && cookie.source));
    if (index >= 0) return list.splice(index, 1)[0];
  }
  return list.shift();
}
