-- Seed runtime settings (migration 0003).
INSERT INTO system_settings (key, value, updated_at) VALUES
  ('install_enabled',        '1', 0),
  ('signup_enabled',         '1', 0),
  ('maintenance_mode',       '0', 0),
  ('default_plan',           'free', 0),
  ('max_global_concurrency', '6', 0),
  ('broadcast_paused',       '0', 0),
  ('support_message',        '', 0),
  ('panel_default_brand',    'Bee.Hive Panel', 0)
ON CONFLICT (key) DO NOTHING;
