CREATE TABLE encrypted_backups (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  client_created_at INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  device_name TEXT NOT NULL DEFAULT '',
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  key_fingerprint TEXT NOT NULL,
  format_version INTEGER NOT NULL,
  app_version TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX encrypted_backups_user_created_idx
  ON encrypted_backups(user_id, created_at DESC);
