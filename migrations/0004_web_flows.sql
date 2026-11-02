-- BEE.HIVE BOT — migration 0004
-- Adds the two short-lived records the web surfaces need:
--   * pending_connections: holds a *sealed* Cloudflare token between step 1
--     (token verification) and step 2 (account selection) of the connect flow.
--   * dashboard_login_codes: one-time codes that prove control of a Telegram
--     account before a dashboard session is created.

CREATE TABLE IF NOT EXISTS pending_connections (
  id             TEXT PRIMARY KEY,               -- random handle given to the browser
  user_id        INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  telegram_chat_id INTEGER NOT NULL,
  ciphertext     TEXT NOT NULL,
  iv             TEXT NOT NULL,
  accounts       TEXT NOT NULL,                  -- JSON: [{id,name}]
  attempts       INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pending_conn_expiry ON pending_connections (expires_at);

CREATE TABLE IF NOT EXISTS dashboard_login_codes (
  id          TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code_hash   TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  consumed_at INTEGER,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_codes_user ON dashboard_login_codes (user_id, expires_at);
