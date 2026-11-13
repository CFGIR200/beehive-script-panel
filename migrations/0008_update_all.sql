-- Migration 0008 — bulk panel update ("update all opened panels") + auto-apply.
--
-- UPDALL-1: the bot can now update every opened panel directly:
--   • user scope  — "🔄 به‌روزرسانی همه" in پنل‌های من (panel:update_all)
--   • admin scope — "🔄 به‌روزرسانی همهٔ پنل‌ها" in the admin menu (adm:update_all)
--   • cron scope  — optional silent rollout for all tenants (auto-apply)
--
-- No schema change is needed (0007 already added the notice bookkeeping
-- columns); this migration only seeds the new runtime settings:
--
--   update_auto_apply — when '1', the cron update check queues an update job
--                       for every outdated panel instead of sending a notice.
--                       Default '0': the operator opts in explicitly, since it
--                       rolls new versions out without per-customer taps.
--   update_apply_batch — max panels auto-applied per cron pass (global
--                        concurrency still caps the actual queue depth).

INSERT INTO system_settings (key, value, updated_at) VALUES
  ('update_auto_apply',  '0',  0),
  ('update_apply_batch', '10', 0)
ON CONFLICT (key) DO NOTHING;
