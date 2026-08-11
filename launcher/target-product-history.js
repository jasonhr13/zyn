'use strict';

const fs = require('fs');
const path = require('path');

const TARGET_PRODUCT_HISTORY_VERSION = 1;
const TARGET_PRODUCT_HISTORY_FILE = 'target-product-history.json';
const DEFAULT_MAX_ITEMS = 500;

function epoch(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function parseSku(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return '';
  const direct = (text.match(/^(\d{6,})/) || [])[1];
  if (direct) return direct;
  const marker = text.toUpperCase().lastIndexOf('A-');
  const rest = marker >= 0 ? text.slice(marker + 2) : text;
  return (rest.match(/^\d+/) || [])[0] || '';
}

function parseSkus(values) {
  const source = Array.isArray(values) ? values : [values];
  const seen = new Set();
  const skus = [];
  for (const value of source) {
    for (const part of String(value == null ? '' : value).split(/[\n,]/)) {
      const sku = parseSku(part);
      if (!sku || seen.has(sku)) continue;
      seen.add(sku);
      skus.push(sku);
    }
  }
  return skus;
}

function cleanName(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, 300);
}

function normalizeItem(raw, fallbackSku = '') {
  const item = raw && typeof raw === 'object' ? raw : {};
  const sku = parseSku(item.sku || fallbackSku);
  if (!sku) return null;
  return {
    sku,
    name: cleanName(item.name),
    firstUsedAt: epoch(item.firstUsedAt),
    lastUsedAt: epoch(item.lastUsedAt),
    lastResolvedAt: epoch(item.lastResolvedAt),
    useCount: Math.max(0, Math.floor(Number(item.useCount) || 0)),
  };
}

function sortItems(items) {
  return [...items].sort((left, right) => (
    right.lastUsedAt - left.lastUsedAt
    || right.lastResolvedAt - left.lastResolvedAt
    || left.sku.localeCompare(right.sku)
  ));
}

function readJson(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return fallback; }
}

function atomicWrite(filePath, value) {
  const directory = path.dirname(filePath);
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, filePath);
    fs.chmodSync(filePath, 0o600);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

function createTargetProductHistoryStore(dataDirectory, options = {}) {
  const filePath = path.join(dataDirectory, TARGET_PRODUCT_HISTORY_FILE);
  const now = options.now || Date.now;
  const maximum = Math.max(1, Number.parseInt(options.maxItems, 10) || DEFAULT_MAX_ITEMS);

  const loadMap = () => {
    const stored = readJson(filePath, { items: {} });
    const rawItems = stored && stored.items && typeof stored.items === 'object' ? stored.items : {};
    const items = {};
    for (const [sku, raw] of Object.entries(rawItems)) {
      const normalized = normalizeItem(raw, sku);
      if (normalized) items[normalized.sku] = normalized;
    }
    return items;
  };

  const writeMap = (items) => {
    const keep = sortItems(Object.values(items)).slice(0, maximum);
    const bounded = {};
    for (const item of keep) bounded[item.sku] = item;
    atomicWrite(filePath, { version: TARGET_PRODUCT_HISTORY_VERSION, items: bounded });
    return bounded;
  };

  const publicList = items => sortItems(Object.values(items)).map(item => ({ ...item }));

  return Object.freeze({
    filePath,
    initialize({ titles = {}, groups = [] } = {}) {
      if (fs.existsSync(filePath)) return publicList(loadMap());
      const timestamp = epoch(now(), Date.now());
      const items = {};
      const touchSeed = (sku, usedAt, name = '') => {
        const id = parseSku(sku);
        if (!id) return;
        const at = epoch(usedAt, timestamp);
        const previous = items[id];
        items[id] = {
          sku: id,
          name: cleanName(name) || (previous && previous.name) || '',
          firstUsedAt: previous ? Math.min(previous.firstUsedAt || at, at) : at,
          lastUsedAt: previous ? Math.max(previous.lastUsedAt, at) : at,
          lastResolvedAt: cleanName(name) ? at : (previous && previous.lastResolvedAt) || 0,
          useCount: previous ? previous.useCount : 1,
        };
      };
      for (const group of (Array.isArray(groups) ? groups : [])) {
        for (const sku of parseSkus(group && group.skus)) {
          touchSeed(sku, group.updatedAt || group.createdAt || timestamp, titles[sku]);
        }
      }
      for (const [value, rawName] of Object.entries(titles || {})) {
        const sku = parseSku(value);
        const name = cleanName(rawName);
        if (!sku || !name) continue;
        if (items[sku]) {
          items[sku] = { ...items[sku], name, lastResolvedAt: timestamp };
        } else {
          touchSeed(sku, timestamp, name);
        }
      }
      return publicList(writeMap(items));
    },
    list() {
      return publicList(loadMap());
    },
    touchSkus(values, usedAt = now()) {
      const skus = parseSkus(values);
      if (!skus.length) return { changed: false, items: publicList(loadMap()) };
      const at = epoch(usedAt, Date.now());
      const items = loadMap();
      for (const sku of skus) {
        const previous = items[sku];
        items[sku] = previous ? {
          ...previous,
          firstUsedAt: previous.firstUsedAt || at,
          lastUsedAt: at,
          useCount: previous.useCount + 1,
        } : {
          sku,
          name: '',
          firstUsedAt: at,
          lastUsedAt: at,
          lastResolvedAt: 0,
          useCount: 1,
        };
      }
      return { changed: true, items: publicList(writeMap(items)) };
    },
    mergeTitles(titles, resolvedAt = now()) {
      const at = epoch(resolvedAt, Date.now());
      const items = loadMap();
      let changed = false;
      for (const [value, rawName] of Object.entries(titles || {})) {
        const sku = parseSku(value);
        const name = cleanName(rawName);
        if (!sku || !name) continue;
        const previous = items[sku];
        if (previous && previous.name === name) continue;
        items[sku] = previous ? {
          ...previous,
          name,
          lastResolvedAt: at,
        } : {
          sku,
          name,
          firstUsedAt: at,
          lastUsedAt: at,
          lastResolvedAt: at,
          useCount: 1,
        };
        changed = true;
      }
      if (!changed) return { changed: false, items: publicList(items) };
      return { changed: true, items: publicList(writeMap(items)) };
    },
  });
}

module.exports = {
  TARGET_PRODUCT_HISTORY_VERSION,
  TARGET_PRODUCT_HISTORY_FILE,
  DEFAULT_MAX_ITEMS,
  parseSku,
  parseSkus,
  createTargetProductHistoryStore,
};
