PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_iterations INTEGER NOT NULL,
  must_reset_password INTEGER NOT NULL DEFAULT 1 CHECK (must_reset_password IN (0, 1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE licenses (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  device_id TEXT NOT NULL,
  device_name TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_validated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoked_reason TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX licenses_user_active_idx ON licenses(user_id, revoked_at, expires_at);
CREATE INDEX licenses_token_idx ON licenses(token_hash);

CREATE TABLE password_reset_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX password_reset_user_idx ON password_reset_tokens(user_id, consumed_at, expires_at);

CREATE TABLE auth_attempts (
  key TEXT PRIMARY KEY,
  failures INTEGER NOT NULL,
  window_started_at INTEGER NOT NULL,
  blocked_until INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE admin_audit (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  target_user_id TEXT,
  target_email TEXT,
  detail TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX admin_audit_created_idx ON admin_audit(created_at DESC);
