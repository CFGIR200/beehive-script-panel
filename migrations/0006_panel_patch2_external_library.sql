-- Migration 0006 — BEEHIVE-PATCH-2 panel bundle (external-config library:
-- bulk-apply to users + auto-include toggle).
--
-- PATCH-2 extends the panel with:
--   * a worker-maintained cache of resolved external configs (settings keys
--     external_resolved_configs / external_resolved_at, refreshed on save, on
--     fetch and by the hourly cron),
--   * POST /api/external-configs/apply (scope or explicit usernames, append or
--     replace mode) and the "apply_external" users-bulk action,
--   * the external_auto_include setting that merges the library into the text
--     subscription of every active, within-quota user (PATCH-1 gating holds:
--     expired/volume-exhausted/inactive users never receive external configs).
--
-- Fresh installations already receive the new hash from migration 0002; for existing
-- deployments this UPDATE pins the registry row to the PATCH-2 digest. Re-upload the
-- artifact to R2 afterwards:
--   node scripts/upload-panel-artifact.mjs --file panel/beehive-panel-3.1.13.js
-- The panel creates the new settings keys lazily at first run — no schema change.

UPDATE panel_versions
SET artifact_sha256 = '0e164a0a8f985e9024ebd1a7de059dedd0915e132638e93513290687eb963cd4',
    notes = 'BEEHIVE-PATCH-1/2 build: external raw configs are gated by user activity/quota; the external-config library supports bulk-apply to users and auto-include into every active subscription (see docs/PATCH-EXTERNAL-CONFIGS.md). Bundle header declares DCVERSION 3.1.13; the embedded config constant reads 3.1.12 (see docs/INITIAL_AUDIT.md §4).'
WHERE version = '3.1.13';
