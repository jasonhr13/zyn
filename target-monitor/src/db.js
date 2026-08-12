import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';
import { classify } from './tiers.js';

mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS products (
  tcin        TEXT PRIMARY KEY,
  title       TEXT,
  url         TEXT,
  image_url   TEXT,
  brand       TEXT,
  marketplace INTEGER DEFAULT 0,
  first_seen  INTEGER,
  last_seen   INTEGER,
  enrolled    INTEGER DEFAULT 1,
  tier        TEXT DEFAULT 'hot',
  misses      INTEGER DEFAULT 0,
  delisted_at INTEGER
);
CREATE TABLE IF NOT EXISTS state (
  tcin           TEXT PRIMARY KEY,
  purchasable    INTEGER,
  status         TEXT,
  price          REAL,
  qty            INTEGER,
  updated_at     INTEGER,
  last_change_at INTEGER
);
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  idem       TEXT UNIQUE,
  type       TEXT,
  tcin       TEXT,
  payload    TEXT,
  created_at INTEGER,
  emitted_at INTEGER
);
CREATE TABLE IF NOT EXISTS sink_failures (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  sink       TEXT,
  event_id   INTEGER,
  attempts   INTEGER,
  last_error TEXT,
  created_at INTEGER
);
`);

// Migration: base_tier (rule-derived, stable) alongside tier (effective, live).
if (!db.prepare('PRAGMA table_info(products)').all().some((c) => c.name === 'base_tier')) {
  db.exec("ALTER TABLE products ADD COLUMN base_tier TEXT DEFAULT 'hot'");
}

const stmt = {
  getProduct: db.prepare('SELECT * FROM products WHERE tcin = ?'),
  upsertProduct: db.prepare(`
    INSERT INTO products (tcin, title, url, image_url, brand, marketplace, first_seen, last_seen, enrolled, tier, base_tier, misses)
    VALUES (@tcin, @title, @url, @image_url, @brand, @marketplace, @now, @now, @enrolled, @base_tier, @base_tier, 0)
    ON CONFLICT(tcin) DO UPDATE SET
      title=@title, url=@url, image_url=@image_url, brand=@brand, marketplace=@marketplace,
      base_tier=@base_tier, last_seen=@now, misses=0, delisted_at=NULL,
      enrolled=CASE WHEN products.delisted_at IS NOT NULL THEN @enrolled ELSE products.enrolled END`),
  enrolledProducts: db.prepare("SELECT * FROM products WHERE enrolled = 1 AND delisted_at IS NULL"),
  setTier: db.prepare('UPDATE products SET tier = ? WHERE tcin = ?'),
  bumpMissesExcept: db.prepare(`
    UPDATE products SET misses = misses + 1
    WHERE enrolled = 1 AND delisted_at IS NULL`),
  resetMisses: db.prepare('UPDATE products SET misses = 0 WHERE tcin = ?'),
  delistStale: db.prepare(`
    UPDATE products SET delisted_at = @now, tier = 'warm'
    WHERE enrolled = 1 AND delisted_at IS NULL AND misses >= @threshold`),
  staleForDelist: db.prepare('SELECT tcin FROM products WHERE enrolled = 1 AND delisted_at IS NULL AND misses >= ?'),

  getState: db.prepare('SELECT * FROM state WHERE tcin = ?'),
  setState: db.prepare(`
    INSERT INTO state (tcin, purchasable, status, price, qty, updated_at, last_change_at)
    VALUES (@tcin, @purchasable, @status, @price, @qty, @now, @last_change_at)
    ON CONFLICT(tcin) DO UPDATE SET
      purchasable=@purchasable, status=@status, price=@price, qty=@qty,
      updated_at=@now, last_change_at=@last_change_at`),

  insertEvent: db.prepare(`
    INSERT OR IGNORE INTO events (idem, type, tcin, payload, created_at)
    VALUES (@idem, @type, @tcin, @payload, @now)`),
  markEmitted: db.prepare('UPDATE events SET emitted_at = ? WHERE id = ?'),
  recentEvents: db.prepare('SELECT type, tcin, payload, created_at FROM events ORDER BY id DESC LIMIT ?'),
  recordFailure: db.prepare(`
    INSERT INTO sink_failures (sink, event_id, attempts, last_error, created_at)
    VALUES (@sink, @event_id, @attempts, @last_error, @now)`),
  counts: db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM products WHERE enrolled = 1 AND delisted_at IS NULL) AS enrolled,
      (SELECT COUNT(*) FROM products WHERE enrolled = 1 AND delisted_at IS NULL AND tier = 'hot') AS hot,
      (SELECT COUNT(*) FROM products WHERE enrolled = 1 AND delisted_at IS NULL AND tier = 'warm') AS warm,
      (SELECT COUNT(*) FROM products) AS total_products,
      (SELECT COUNT(*) FROM state WHERE purchasable = 1) AS in_stock,
      (SELECT COUNT(*) FROM events) AS events`),
};

export function upsertProduct(p) {
  const now = Date.now();
  const existed = stmt.getProduct.get(p.tcin);
  stmt.upsertProduct.run({
    tcin: p.tcin,
    title: p.title ?? null,
    url: p.url ?? null,
    image_url: p.image ?? null,
    brand: p.brand ?? null,
    marketplace: p.marketplace ? 1 : 0,
    base_tier: classify(p),
    enrolled: 1,
    now,
  });
  return { isNew: !existed };
}

export const getProduct = (tcin) => stmt.getProduct.get(tcin);
export const getEnrolled = () => stmt.enrolledProducts.all();
export const setTier = (tcin, tier) => stmt.setTier.run(tier, tcin);
export const resetMisses = (tcin) => stmt.resetMisses.run(tcin);
export const getState = (tcin) => stmt.getState.get(tcin);
export const setState = (s) => stmt.setState.run(s);
export const recentEvents = (n) => stmt.recentEvents.all(n).map((e) => ({ ...e, payload: JSON.parse(e.payload) }));
export const counts = () => stmt.counts.get();

// Mark every enrolled product a miss, then reset the ones actually seen this cycle.
export function applyDiscoveryMisses(seenTcins, threshold) {
  const tx = db.transaction((seen) => {
    stmt.bumpMissesExcept.run();
    for (const tcin of seen) stmt.resetMisses.run(tcin);
    const stale = stmt.staleForDelist.all(threshold).map((r) => r.tcin);
    stmt.delistStale.run({ now: Date.now(), threshold });
    return stale;
  });
  return tx(seenTcins);
}

export function insertEvent({ idem, type, tcin, payload }) {
  const info = stmt.insertEvent.run({ idem, type, tcin, payload: JSON.stringify(payload), now: Date.now() });
  return info.changes > 0 ? info.lastInsertRowid : null; // null = duplicate (already recorded)
}
export const markEmitted = (id) => stmt.markEmitted.run(Date.now(), id);
export const recordFailure = (sink, eventId, attempts, error) =>
  stmt.recordFailure.run({ sink, event_id: eventId, attempts, last_error: String(error).slice(0, 500), now: Date.now() });
