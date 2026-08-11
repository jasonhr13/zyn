CREATE TABLE service_config (
  name TEXT PRIMARY KEY,
  encrypted_value TEXT NOT NULL,
  iv TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE service_rate_windows (
  user_id TEXT NOT NULL,
  service TEXT NOT NULL,
  window_started_at INTEGER NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, service),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX service_rate_windows_updated_idx ON service_rate_windows(updated_at);
