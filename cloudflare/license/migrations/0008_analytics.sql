PRAGMA foreign_keys = ON;

CREATE TABLE analytics_events (
  user_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('carted', 'checkout', 'decline')),
  site TEXT NOT NULL,
  task_id TEXT NOT NULL DEFAULT '',
  run_id TEXT NOT NULL DEFAULT '',
  order_number TEXT NOT NULL DEFAULT '',
  total_cents INTEGER NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  occurred_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  ingest_id TEXT NOT NULL,
  PRIMARY KEY (user_id, event_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX analytics_events_user_time_idx
  ON analytics_events(user_id, occurred_at DESC);
CREATE INDEX analytics_events_user_type_time_idx
  ON analytics_events(user_id, event_type, occurred_at DESC);
CREATE INDEX analytics_events_user_run_idx
  ON analytics_events(user_id, run_id, occurred_at);

CREATE TABLE analytics_items (
  user_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  line_number INTEGER NOT NULL CHECK (line_number >= 0),
  sku TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  image TEXT NOT NULL DEFAULT '',
  product_url TEXT NOT NULL DEFAULT '',
  size TEXT NOT NULL DEFAULT '',
  unit_price_cents INTEGER NOT NULL DEFAULT 0 CHECK (unit_price_cents >= 0),
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  PRIMARY KEY (user_id, event_id, line_number),
  FOREIGN KEY (user_id, event_id) REFERENCES analytics_events(user_id, event_id) ON DELETE CASCADE
);

CREATE INDEX analytics_items_user_sku_idx ON analytics_items(user_id, sku);
CREATE INDEX analytics_items_user_name_idx ON analytics_items(user_id, name COLLATE NOCASE);
