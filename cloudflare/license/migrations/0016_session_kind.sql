-- Full Engine sessions consume max_active_devices. Harvester-only sessions do not.
ALTER TABLE licenses ADD COLUMN session_kind TEXT NOT NULL DEFAULT 'engine'
  CHECK (session_kind IN ('engine', 'harvester'));

CREATE INDEX licenses_user_engine_active_idx
  ON licenses(user_id, revoked_at, expires_at, session_kind);
