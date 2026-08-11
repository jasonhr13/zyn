ALTER TABLE users ADD COLUMN max_active_devices INTEGER NOT NULL DEFAULT 1
  CHECK (max_active_devices BETWEEN 1 AND 10);

-- A device can own only one current token. Historical, expired, and revoked sessions remain
-- available for support/audit context without consuming an active-device slot.
CREATE UNIQUE INDEX licenses_user_active_device_idx
  ON licenses(user_id, device_id)
  WHERE revoked_at IS NULL;
