-- Seed subscription plans (migration 0002).
-- Limits live here and only here: the bot reads them at runtime, nothing is
-- hard-coded per feature. -1 means "unlimited".

INSERT INTO subscription_plans
  (code, name, description, price_toman, duration_days, max_panels, max_accounts,
   max_concurrent_jobs, allow_update, allow_backup, allow_custom_domain,
   max_backup_bytes, is_active, sort_order, updated_at)
VALUES
  ('free', 'رایگان', 'شروع آزمایشی — یک پنل، بدون پشتیبان‌گیری',
   0, 0, 1, 1, 1, 1, 0, 0, 0, 1, 10, 0),
  ('basic', 'پایه', 'دو پنل، به‌روزرسانی و پشتیبان‌گیری دستی',
   149000, 30, 2, 2, 1, 1, 1, 0, 26214400, 1, 20, 0),
  ('pro', 'حرفه‌ای', 'پنج پنل، چند حساب، پشتیبان‌گیری و بازیابی',
   349000, 30, 5, 3, 2, 1, 1, 1, 104857600, 1, 30, 0),
  ('enterprise', 'سازمانی', 'بدون محدودیت تعداد پنل، اولویت پردازش',
   0, 0, -1, -1, 4, 1, 1, 1, 524288000, 1, 40, 0)
ON CONFLICT (code) DO NOTHING;

-- Approved panel artifact registry. The sha256 is the integrity anchor: the
-- installer refuses to deploy a bundle whose hash does not match this row.
INSERT INTO panel_versions
  (version, artifact_key, artifact_sha256, compatibility_date, notes, is_active, created_at)
VALUES
  ('3.1.13',
   'panel/beehive-panel-3.1.13.js',
   '0e164a0a8f985e9024ebd1a7de059dedd0915e132638e93513290687eb963cd4',
   '2025-03-10',
   'BEEHIVE-PATCH-1/2 build: external raw configs are gated by user activity/quota; the panel-level external-config library supports bulk-apply to users and auto-include into every active subscription (see docs/PATCH-EXTERNAL-CONFIGS.md). Bundle header declares DCVERSION 3.1.13; the embedded config constant reads 3.1.12 (see docs/INITIAL_AUDIT.md §4).',
   1, 0)
ON CONFLICT (version) DO NOTHING;
