-- D1 bookkeeping for the "dashboard-only" install path.
--
-- Run this ONCE in the Cloudflare dashboard (D1 → beehive_bot → Console) AFTER you
-- have pasted migrations/0001_init.sql … 0004_web_flows.sql in order.
--
-- Why: `wrangler d1 migrations apply` records every applied file in the
-- d1_migrations table. If you apply the SQL by hand, that table stays empty and a
-- later `npm run db:migrate:remote` would try to re-run migrations 0001-0004 and
-- fail halfway (tables already exist). This file creates the table with exactly
-- the schema Wrangler uses and marks the four migrations as applied, so both
-- paths stay compatible.
--
-- Safe to run more than once (IF NOT EXISTS / INSERT OR IGNORE).

CREATE TABLE IF NOT EXISTS d1_migrations(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);

INSERT OR IGNORE INTO d1_migrations (name) VALUES
  ('0001_init.sql'),
  ('0002_seed_plans.sql'),
  ('0003_seed_settings.sql'),
  ('0004_web_flows.sql');

-- Sanity check — expect 4 rows.
SELECT id, name, applied_at FROM d1_migrations ORDER BY id;
