ALTER TABLE users ADD COLUMN proxy_access INTEGER NOT NULL DEFAULT 0
  CHECK (proxy_access IN (0, 1));

CREATE TABLE managed_proxy_lists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  encrypted_raw TEXT NOT NULL,
  iv TEXT NOT NULL,
  proxy_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX managed_proxy_lists_name_idx ON managed_proxy_lists(name);
