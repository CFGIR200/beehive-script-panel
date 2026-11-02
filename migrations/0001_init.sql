-- BEE.HIVE BOT — initial schema (migration 0001)
-- All timestamps are unix epoch milliseconds (INTEGER) unless a column says otherwise.
-- Tenant isolation rule: every table that holds customer data is keyed by user_id and
-- every query in src/database/repositories/* filters on it.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Identity & access
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id       INTEGER NOT NULL UNIQUE,
  username          TEXT,
  first_name        TEXT,
  last_name         TEXT,
  language_code     TEXT,
  is_blocked        INTEGER NOT NULL DEFAULT 0,
  blocked_reason    TEXT,
  created_at        INTEGER NOT NULL,
  last_seen_at      INTEGER NOT NULL,
  notes             TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_created  ON users (created_at);
CREATE INDEX IF NOT EXISTS idx_users_blocked  ON users (is_blocked);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('super_admin','admin','support','user')),
  granted_by  INTEGER,
  granted_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, role)
);
CREATE INDEX IF NOT EXISTS idx_user_roles_role ON user_roles (role);

-- Server-side bot conversation state (one row per chat).
CREATE TABLE IF NOT EXISTS bot_sessions (
  chat_id     INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  state       TEXT NOT NULL,
  payload     TEXT NOT NULL DEFAULT '{}',
  message_id  INTEGER,
  updated_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bot_sessions_expiry ON bot_sessions (expires_at);

-- ---------------------------------------------------------------------------
-- Cloudflare connections
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cloudflare_accounts (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id                 INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  cloudflare_account_id   TEXT NOT NULL,
  account_name            TEXT NOT NULL,
  token_verified_at       INTEGER NOT NULL,
  token_status            TEXT NOT NULL DEFAULT 'active',
  token_expires_on        TEXT,
  token_id_suffix         TEXT,
  permissions_verified    INTEGER NOT NULL DEFAULT 0,
  permissions_detail      TEXT,
  workers_subdomain       TEXT,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL,
  last_error              TEXT,
  UNIQUE (user_id, cloudflare_account_id)
);
CREATE INDEX IF NOT EXISTS idx_cf_accounts_user ON cloudflare_accounts (user_id);

-- Encrypted credentials live in their own table so that listing accounts never
-- touches ciphertext, and so a single row can be revoked without touching accounts.
CREATE TABLE IF NOT EXISTS encrypted_credentials (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  account_ref     INTEGER NOT NULL REFERENCES cloudflare_accounts (id) ON DELETE CASCADE,
  purpose         TEXT NOT NULL CHECK (purpose IN ('cloudflare_api_token')),
  ciphertext      TEXT NOT NULL,
  iv              TEXT NOT NULL,
  key_version     INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL,
  rotated_at      INTEGER,
  revoked_at      INTEGER,
  UNIQUE (account_ref, purpose)
);
CREATE INDEX IF NOT EXISTS idx_credentials_user ON encrypted_credentials (user_id);

-- ---------------------------------------------------------------------------
-- Panels
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS panels (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  uid                   TEXT NOT NULL UNIQUE,          -- opaque public id
  user_id               INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  account_ref           INTEGER NOT NULL REFERENCES cloudflare_accounts (id) ON DELETE CASCADE,
  cloudflare_account_id TEXT NOT NULL,
  worker_name           TEXT NOT NULL,
  d1_database_name      TEXT NOT NULL,
  d1_database_id        TEXT,
  panel_url             TEXT,
  status                TEXT NOT NULL DEFAULT 'provisioning',
  status_reason         TEXT,
  version               TEXT,
  artifact_sha256       TEXT,
  recovery_key_sealed   TEXT,                          -- encrypted, shown once to the owner
  api_token_sealed      TEXT,                          -- encrypted, optional automation token
  workers_dev_enabled   INTEGER NOT NULL DEFAULT 0,
  cron_schedule         TEXT,
  last_health_check_at  INTEGER,
  last_health_status    TEXT,
  last_health_latency_ms INTEGER,
  installed_at          INTEGER,
  updated_at            INTEGER NOT NULL,
  deleted_at            INTEGER,
  UNIQUE (cloudflare_account_id, worker_name)
);
CREATE INDEX IF NOT EXISTS idx_panels_user    ON panels (user_id);
CREATE INDEX IF NOT EXISTS idx_panels_status  ON panels (status);

CREATE TABLE IF NOT EXISTS panel_resources (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  panel_id      INTEGER NOT NULL REFERENCES panels (id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('worker_script','d1_database','cron_trigger','workers_dev','secret')),
  external_id   TEXT NOT NULL,
  created_by_bot INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  deleted_at    INTEGER,
  meta          TEXT,
  UNIQUE (panel_id, kind, external_id)
);
CREATE INDEX IF NOT EXISTS idx_resources_panel ON panel_resources (panel_id);

CREATE TABLE IF NOT EXISTS panel_versions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  version           TEXT NOT NULL UNIQUE,
  artifact_key      TEXT NOT NULL,
  artifact_sha256   TEXT NOT NULL,
  compatibility_date TEXT NOT NULL,
  notes             TEXT,
  is_active         INTEGER NOT NULL DEFAULT 1,
  created_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS panel_backups (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  panel_id      INTEGER NOT NULL REFERENCES panels (id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  object_key    TEXT,
  size_bytes    INTEGER,
  checksum      TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER,
  error         TEXT
);
CREATE INDEX IF NOT EXISTS idx_backups_panel ON panel_backups (panel_id);

-- ---------------------------------------------------------------------------
-- Jobs (resumable provisioning engine)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS deployment_jobs (
  id              TEXT PRIMARY KEY,                    -- uuid
  user_id         INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  panel_id        INTEGER REFERENCES panels (id) ON DELETE CASCADE,
  account_ref     INTEGER,
  kind            TEXT NOT NULL CHECK (kind IN ('install','update','redeploy','delete','backup','restore','health')),
  status          TEXT NOT NULL CHECK (status IN ('pending','validating','provisioning','configuring','deploying','verifying','completed','failed','cancelled','rollback_required','rolled_back')),
  current_step    TEXT,
  steps_total     INTEGER NOT NULL DEFAULT 0,
  steps_done      INTEGER NOT NULL DEFAULT 0,
  attempt         INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 3,
  payload         TEXT NOT NULL DEFAULT '{}',
  result          TEXT,
  error_code      TEXT,
  error_message   TEXT,
  trace_id        TEXT NOT NULL,
  telegram_chat_id INTEGER,
  telegram_message_id INTEGER,
  lease_owner     TEXT,
  locked_until    INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  finished_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_jobs_user    ON deployment_jobs (user_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status  ON deployment_jobs (status, locked_until);
CREATE INDEX IF NOT EXISTS idx_jobs_panel   ON deployment_jobs (panel_id);

CREATE TABLE IF NOT EXISTS deployment_steps (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id      TEXT NOT NULL REFERENCES deployment_jobs (id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('pending','running','done','failed','skipped')),
  message     TEXT,
  error_code  TEXT,
  started_at  INTEGER,
  finished_at INTEGER,
  attempts    INTEGER NOT NULL DEFAULT 0,
  UNIQUE (job_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_steps_job ON deployment_steps (job_id, seq);

-- ---------------------------------------------------------------------------
-- Subscriptions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS subscription_plans (
  code                  TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  description           TEXT,
  price_toman           INTEGER NOT NULL DEFAULT 0,
  duration_days         INTEGER NOT NULL DEFAULT 0,     -- 0 = unlimited
  max_panels            INTEGER NOT NULL DEFAULT 1,     -- -1 = unlimited
  max_accounts          INTEGER NOT NULL DEFAULT 1,
  max_concurrent_jobs   INTEGER NOT NULL DEFAULT 1,
  allow_update          INTEGER NOT NULL DEFAULT 1,
  allow_backup          INTEGER NOT NULL DEFAULT 0,
  allow_custom_domain   INTEGER NOT NULL DEFAULT 0,
  max_backup_bytes      INTEGER NOT NULL DEFAULT 0,
  is_active             INTEGER NOT NULL DEFAULT 1,
  sort_order            INTEGER NOT NULL DEFAULT 0,
  updated_at            INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  plan_code     TEXT NOT NULL REFERENCES subscription_plans (code),
  status        TEXT NOT NULL CHECK (status IN ('active','expired','cancelled','pending')),
  started_at    INTEGER NOT NULL,
  expires_at    INTEGER,                                -- NULL = never
  granted_by    INTEGER,
  note          TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subs_user   ON subscriptions (user_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_subs_active ON subscriptions (user_id) WHERE status = 'active';

-- Payment ledger. v1.0.0 ships no payment provider (FEATURE_PAYMENTS=false):
-- rows can only be inserted by an admin as a manual record.
CREATE TABLE IF NOT EXISTS payments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  subscription_id INTEGER REFERENCES subscriptions (id) ON DELETE SET NULL,
  provider      TEXT NOT NULL DEFAULT 'manual',
  provider_ref  TEXT,
  amount_toman  INTEGER NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('pending','paid','failed','refunded')),
  raw           TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payments_user ON payments (user_id);

-- ---------------------------------------------------------------------------
-- Operations: audit, support, webhooks, idempotency, rate limits
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_type  TEXT NOT NULL CHECK (actor_type IN ('telegram_user','admin','system','web')),
  actor_id    INTEGER,
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  severity    TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('debug','info','warning','error','critical')),
  ip          TEXT,
  trace_id    TEXT,
  detail      TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs (created_at);
CREATE INDEX IF NOT EXISTS idx_audit_action  ON audit_logs (action);
CREATE INDEX IF NOT EXISTS idx_audit_actor   ON audit_logs (actor_type, actor_id);

CREATE TABLE IF NOT EXISTS system_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT,
  updated_by  INTEGER,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS support_tickets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  subject     TEXT NOT NULL,
  body        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','closed')),
  answer      TEXT,
  answered_by INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON support_tickets (status);

CREATE TABLE IF NOT EXISTS webhook_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source      TEXT NOT NULL,
  update_id   INTEGER,
  dedupe_key  TEXT NOT NULL UNIQUE,
  payload_hash TEXT,
  handled     INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  received_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_webhook_received ON webhook_events (received_at);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key         TEXT PRIMARY KEY,
  scope       TEXT NOT NULL,
  response    TEXT,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket_key   TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS connect_links (
  token_hash    TEXT PRIMARY KEY,               -- sha256 of the one-time token
  user_id       INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  telegram_chat_id INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','used','expired','revoked')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  used_at       INTEGER,
  ip            TEXT
);
CREATE INDEX IF NOT EXISTS idx_connect_user ON connect_links (user_id);

-- Dashboard sessions (independent from the panel's own session cookie)
CREATE TABLE IF NOT EXISTS admin_sessions (
  id          TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  ip          TEXT,
  user_agent  TEXT
);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_expiry ON admin_sessions (expires_at);
