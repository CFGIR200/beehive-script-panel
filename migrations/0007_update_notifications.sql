-- Migration 0007 — panel update notifications.
--
-- Adds per-panel notice bookkeeping so the cron can tell each panel owner
-- exactly once per new version (then remind at most every
-- update_notify_interval_hours) until the panel is actually updated:
--
--   update_notified_version — the target version the owner was last notified about
--   update_notice_at        — when that notice was sent (ms epoch)
--
-- Also seeds the notification settings (see docs/UPDATES.md). The admin bot
-- screen can flip update_notify_enabled at runtime.

ALTER TABLE panels ADD COLUMN update_notified_version TEXT;
ALTER TABLE panels ADD COLUMN update_notice_at INTEGER;

INSERT INTO system_settings (key, value, updated_at) VALUES
  ('update_notify_enabled',        '1',  0),
  ('update_notify_interval_hours', '24', 0),
  ('update_notify_batch',          '10', 0),
  ('update_check_min_minutes',     '30', 0)
ON CONFLICT (key) DO NOTHING;
