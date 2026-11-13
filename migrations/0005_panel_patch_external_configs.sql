-- Migration 0005 — BEEHIVE-PATCH-1 panel bundle (external raw configs gated by quota).
--
-- The approved 3.1.13 bundle was rebuilt with BEEHIVE-PATCH-1: per-user external raw
-- configs are no longer served to users whose time or volume has run out (or who are
-- inactive), so clients drop them on their next subscription refresh.
-- See docs/PATCH-EXTERNAL-CONFIGS.md.
--
-- Fresh installations already receive the new hash from migration 0002; for existing
-- deployments this UPDATE pins the registry row to the patched digest. Re-upload the
-- artifact to R2 afterwards:
--   node scripts/upload-panel-artifact.mjs --file panel/beehive-panel-3.1.13.js

UPDATE panel_versions
SET artifact_sha256 = '7381d693589a7699496d8ca86f6fc020199bb7e092d81b02d54d72f0f8919bc0',
    notes = 'BEEHIVE-PATCH-1 build: external raw configs are gated by user activity/quota (see docs/PATCH-EXTERNAL-CONFIGS.md). Bundle header declares DCVERSION 3.1.13; the embedded config constant reads 3.1.12 (see docs/INITIAL_AUDIT.md §4).'
WHERE version = '3.1.13';
