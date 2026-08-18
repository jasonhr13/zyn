PRAGMA foreign_keys = ON;

ALTER TABLE users ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE users ADD COLUMN stripe_subscription_id TEXT;
ALTER TABLE users ADD COLUMN billing_plan TEXT;
ALTER TABLE users ADD COLUMN billing_status TEXT;
ALTER TABLE users ADD COLUMN access_until INTEGER;

CREATE UNIQUE INDEX users_stripe_customer_idx ON users(stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL AND stripe_customer_id != '';
CREATE UNIQUE INDEX users_stripe_subscription_idx ON users(stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL AND stripe_subscription_id != '';
CREATE INDEX users_access_until_idx ON users(access_until);

CREATE TABLE stripe_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  processed_at INTEGER
);

CREATE TABLE billing_claims (
  checkout_session_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_new_user INTEGER NOT NULL DEFAULT 0 CHECK (created_new_user IN (0, 1)),
  temporary_password TEXT,
  download_url TEXT,
  claimed_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX billing_claims_user_idx ON billing_claims(user_id, claimed_at);
