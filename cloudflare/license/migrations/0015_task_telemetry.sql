PRAGMA foreign_keys = ON;

-- Hourly counters of how tasks fare against site protections (cart attempts, Shape blocks,
-- rate limits, ...). Clients pre-aggregate and upload deltas; each upload carries a batch id
-- so a replayed batch whose response was lost is applied only once.
CREATE TABLE analytics_task_batches (
  user_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  ingest_id TEXT NOT NULL,
  bucket_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, batch_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX analytics_task_batches_created_idx ON analytics_task_batches(created_at);

CREATE TABLE analytics_task_rollups (
  user_id TEXT NOT NULL,
  bucket_start INTEGER NOT NULL,
  site TEXT NOT NULL,
  event TEXT NOT NULL,
  step TEXT NOT NULL DEFAULT '',
  shape_method TEXT NOT NULL DEFAULT '',
  cookie_type TEXT NOT NULL DEFAULT '',
  engine_version TEXT NOT NULL DEFAULT '',
  app_version TEXT NOT NULL DEFAULT '',
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  cookie_age_ms_total INTEGER NOT NULL DEFAULT 0 CHECK (cookie_age_ms_total >= 0),
  cookie_age_samples INTEGER NOT NULL DEFAULT 0 CHECK (cookie_age_samples >= 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, bucket_start, site, event, step, shape_method, cookie_type, engine_version, app_version),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX analytics_task_rollups_time_idx
  ON analytics_task_rollups(bucket_start, site, event);
CREATE INDEX analytics_task_rollups_user_time_idx
  ON analytics_task_rollups(user_id, bucket_start);
