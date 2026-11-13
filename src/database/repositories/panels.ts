/** Panels, their resources, versions and backups. */

import type { Env } from "../../config/env";
import { all, batch, one, run, scalar, stmt, type Pagination } from "../db";
import { now } from "../../utils/time";

export type PanelStatus =
  | "provisioning"
  | "active"
  | "degraded"
  | "updating"
  | "deleting"
  | "deleted"
  | "failed";

export interface Panel {
  id: number;
  uid: string;
  user_id: number;
  account_ref: number;
  cloudflare_account_id: string;
  worker_name: string;
  d1_database_name: string;
  d1_database_id: string | null;
  panel_url: string | null;
  status: PanelStatus;
  status_reason: string | null;
  version: string | null;
  artifact_sha256: string | null;
  recovery_key_sealed: string | null;
  api_token_sealed: string | null;
  workers_dev_enabled: number;
  cron_schedule: string | null;
  last_health_check_at: number | null;
  last_health_status: string | null;
  last_health_latency_ms: number | null;
  /** Target version the owner was last notified about (update notifications). */
  update_notified_version: string | null;
  /** When that notice was sent (ms epoch). */
  update_notice_at: number | null;
  installed_at: number | null;
  updated_at: number;
  deleted_at: number | null;
}

export type ResourceKind = "worker_script" | "d1_database" | "cron_trigger" | "workers_dev" | "secret";

export interface PanelResource {
  id: number;
  panel_id: number;
  kind: ResourceKind;
  external_id: string;
  created_by_bot: number;
  created_at: number;
  deleted_at: number | null;
  meta: string | null;
}

export interface PanelVersion {
  id: number;
  version: string;
  artifact_key: string;
  artifact_sha256: string;
  compatibility_date: string;
  notes: string | null;
  /** Persian release changelog (one change per line) shown by the bot on updates. */
  changelog_fa: string | null;
  is_active: number;
  created_at: number;
}

export async function reserve(env: Env, input: {
  uid: string;
  userId: number;
  accountRef: number;
  cloudflareAccountId: string;
  workerName: string;
  d1DatabaseName: string;
  status?: PanelStatus;
  version: string;
}): Promise<Panel> {
  await run(
    env,
    `INSERT INTO panels
       (uid, user_id, account_ref, cloudflare_account_id, worker_name, d1_database_name, status,
        version, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.uid,
    input.userId,
    input.accountRef,
    input.cloudflareAccountId,
    input.workerName,
    input.d1DatabaseName,
    input.status ?? "provisioning",
    input.version,
    now(),
  );
  const panel = await one<Panel>(env, "SELECT * FROM panels WHERE uid = ?", input.uid);
  if (!panel) throw new Error("panel reserve failed");
  return panel;
}

export async function findById(env: Env, id: number): Promise<Panel | null> {
  return one<Panel>(env, "SELECT * FROM panels WHERE id = ?", id);
}

export async function findByUid(env: Env, uid: string): Promise<Panel | null> {
  return one<Panel>(env, "SELECT * FROM panels WHERE uid = ?", uid);
}

/** Tenant-scoped read. */
export async function findForUser(env: Env, userId: number, id: number): Promise<Panel | null> {
  return one<Panel>(env, "SELECT * FROM panels WHERE id = ? AND user_id = ?", id, userId);
}

export async function listForUser(env: Env, userId: number, options: { includeDeleted?: boolean } = {}): Promise<Panel[]> {
  const where = options.includeDeleted ? "" : "AND deleted_at IS NULL";
  return all<Panel>(
    env,
    `SELECT * FROM panels WHERE user_id = ? ${where} ORDER BY installed_at DESC, id DESC`,
    userId,
  );
}

export async function listAll(env: Env, page: Pagination, status?: string): Promise<Panel[]> {
  if (status) {
    return all<Panel>(
      env,
      "SELECT * FROM panels WHERE status = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?",
      status,
      page.limit,
      page.offset,
    );
  }
  return all<Panel>(env, "SELECT * FROM panels ORDER BY updated_at DESC LIMIT ? OFFSET ?", page.limit, page.offset);
}

export async function countForUser(env: Env, userId: number): Promise<number> {
  return scalar(env, "SELECT COUNT(*) FROM panels WHERE user_id = ? AND deleted_at IS NULL", userId);
}

export async function countAll(env: Env, status?: PanelStatus): Promise<number> {
  if (status) return scalar(env, "SELECT COUNT(*) FROM panels WHERE status = ? AND deleted_at IS NULL", status);
  return scalar(env, "SELECT COUNT(*) FROM panels WHERE deleted_at IS NULL");
}

export async function countByStatus(env: Env): Promise<Record<string, number>> {
  const rows = await all<{ status: string; n: number }>(
    env,
    "SELECT status, COUNT(*) AS n FROM panels WHERE deleted_at IS NULL GROUP BY status",
  );
  const out: Record<string, number> = {};
  for (const row of rows) out[row.status] = Number(row.n);
  return out;
}

export async function workerNamesForAccount(env: Env, accountRef: number): Promise<string[]> {
  const rows = await all<{ worker_name: string }>(
    env,
    "SELECT worker_name FROM panels WHERE account_ref = ?",
    accountRef,
  );
  return rows.map((row) => row.worker_name);
}

export async function updateStatus(
  env: Env,
  panelId: number,
  status: PanelStatus,
  reason: string | null = null,
): Promise<void> {
  await run(env, "UPDATE panels SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?", status, reason, now(), panelId);
}

export async function markInstalled(env: Env, panelId: number, input: {
  panelUrl: string;
  d1DatabaseId: string;
  artifactSha256: string;
  version: string;
  recoveryKeySealed: string | null;
  apiTokenSealed: string | null;
  cronSchedule: string;
}): Promise<void> {
  const ts = now();
  await run(
    env,
    `UPDATE panels
        SET status = 'active', status_reason = NULL, panel_url = ?, d1_database_id = ?,
            artifact_sha256 = ?, version = ?, recovery_key_sealed = ?, api_token_sealed = ?,
            cron_schedule = ?, workers_dev_enabled = 1, installed_at = COALESCE(installed_at, ?), updated_at = ?
      WHERE id = ?`,
    input.panelUrl,
    input.d1DatabaseId,
    input.artifactSha256,
    input.version,
    input.recoveryKeySealed,
    input.apiTokenSealed,
    input.cronSchedule,
    ts,
    ts,
    panelId,
  );
}

/** Persists the sealed panel secrets (JSON of SealedValue) without changing status. */
export async function savePanelSecrets(env: Env, panelId: number, input: {
  recoveryKeySealed?: string | null;
  apiTokenSealed?: string | null;
}): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (input.recoveryKeySealed !== undefined) {
    sets.push("recovery_key_sealed = ?");
    params.push(input.recoveryKeySealed);
  }
  if (input.apiTokenSealed !== undefined) {
    sets.push("api_token_sealed = ?");
    params.push(input.apiTokenSealed);
  }
  if (!sets.length) return;
  params.push(now(), panelId);
  await run(env, `UPDATE panels SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`, ...params);
}

/** Records artifact/database identifiers as soon as they are known. */
export async function setArtifact(env: Env, panelId: number, input: {
  version: string;
  artifactSha256: string;
  d1DatabaseId: string | null;
  panelUrl?: string | null;
}): Promise<void> {
  await run(
    env,
    `UPDATE panels SET version = ?, artifact_sha256 = ?, d1_database_id = COALESCE(?, d1_database_id),
        panel_url = COALESCE(?, panel_url), updated_at = ? WHERE id = ?`,
    input.version,
    input.artifactSha256,
    input.d1DatabaseId,
    input.panelUrl ?? null,
    now(),
    panelId,
  );
}

export async function recordHealth(
  env: Env,
  panelId: number,
  input: { status: string; latencyMs: number | null },
): Promise<void> {
  await run(
    env,
    `UPDATE panels SET last_health_check_at = ?, last_health_status = ?, last_health_latency_ms = ?, updated_at = ?
      WHERE id = ?`,
    now(),
    input.status,
    input.latencyMs,
    now(),
    panelId,
  );
}

export async function markDeleted(env: Env, panelId: number, reason: string): Promise<void> {
  const ts = now();
  await run(
    env,
    `UPDATE panels SET status = 'deleted', deleted_at = ?, status_reason = ?, recovery_key_sealed = NULL,
        api_token_sealed = NULL, updated_at = ? WHERE id = ?`,
    ts,
    reason,
    ts,
    panelId,
  );
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

export async function addResource(env: Env, input: {
  panelId: number;
  kind: ResourceKind;
  externalId: string;
  meta?: string | null;
}): Promise<void> {
  await run(
    env,
    `INSERT INTO panel_resources (panel_id, kind, external_id, created_by_bot, created_at, meta)
     VALUES (?, ?, ?, 1, ?, ?)
     ON CONFLICT (panel_id, kind, external_id) DO UPDATE SET deleted_at = NULL, meta = excluded.meta`,
    input.panelId,
    input.kind,
    input.externalId,
    now(),
    input.meta ?? null,
  );
}

/** Marks a resource as removed so the deletion job is resumable and auditable. */
export async function markResourceDeleted(env: Env, panelId: number, kind: ResourceKind, externalId: string): Promise<void> {
  await run(
    env,
    "UPDATE panel_resources SET deleted_at = ? WHERE panel_id = ? AND kind = ? AND external_id = ?",
    now(),
    panelId,
    kind,
    externalId,
  );
}

export async function resourcesOf(env: Env, panelId: number): Promise<PanelResource[]> {
  return all<PanelResource>(env, "SELECT * FROM panel_resources WHERE panel_id = ? ORDER BY id ASC", panelId);
}

export async function liveResourcesOf(env: Env, panelId: number): Promise<PanelResource[]> {
  return all<PanelResource>(
    env,
    "SELECT * FROM panel_resources WHERE panel_id = ? AND deleted_at IS NULL ORDER BY id ASC",
    panelId,
  );
}

// ---------------------------------------------------------------------------
// Update notifications
// ---------------------------------------------------------------------------

export interface OutdatedPanelRow {
  id: number;
  worker_name: string;
  version: string;
  user_telegram_id: number;
}

/**
 * Active panels that are behind the approved latest version and are due a
 * Telegram notice: either never notified for this target version, or the last
 * notice is older than the reminder interval. Blocked owners and non-active
 * panels (updating/deleting/deleted/failed) never match.
 */
export async function listOutdatedForNotify(env: Env, input: {
  latestVersion: string;
  expectedSha256: string;
  renotifyBefore: number;
  limit: number;
}): Promise<OutdatedPanelRow[]> {
  return all<OutdatedPanelRow>(
    env,
    `SELECT p.id, p.worker_name, p.version, u.telegram_id AS user_telegram_id
       FROM panels p
       JOIN users u ON u.id = p.user_id
      WHERE p.deleted_at IS NULL
        AND p.status = 'active'
        AND p.version IS NOT NULL
        AND (p.version != ?1 OR COALESCE(p.artifact_sha256, '') != ?2)
        AND u.is_blocked = 0
        AND NOT (
          p.update_notified_version = ?3
          AND p.update_notice_at IS NOT NULL
          AND p.update_notice_at > ?4
        )
      ORDER BY COALESCE(p.update_notice_at, 0) ASC, p.id ASC
      LIMIT ?5`,
    input.latestVersion,
    input.expectedSha256,
    input.latestVersion,
    input.renotifyBefore,
    input.limit,
  );
}

/** Records that the owner was notified about `version` (dedupes future checks). */
export async function markUpdateNotified(env: Env, panelId: number, version: string): Promise<void> {
  await run(
    env,
    "UPDATE panels SET update_notified_version = ?, update_notice_at = ? WHERE id = ?",
    version,
    now(),
    panelId,
  );
}

// ---------------------------------------------------------------------------
// Bulk update ("update all opened panels")
// ---------------------------------------------------------------------------

/** An outdated active panel with everything the batch updater needs. */
export interface BatchOutdatedRow {
  id: number;
  user_id: number;
  worker_name: string;
  version: string;
  /** Owner's Telegram chat id — null only for exotic rows; progress falls back to no push. */
  user_telegram_id: number | null;
}

/**
 * "Outdated" is BUILD-level, not just version-level: the patched 3.1.13
 * artifact and the original upstream 3.1.13 share the same version string,
 * so a panel is current only when BOTH the version and the recorded build
 * digest (artifact_sha256, written by the deploy pipeline) match the approved
 * artifact. Panels installed before digest tracking have a NULL/foreign
 * digest — they are treated as outdated exactly once and converge after the
 * first update records the approved digest.
 */
const OUTDATED_BASE = `
  FROM panels p
  JOIN users u ON u.id = p.user_id
 WHERE p.deleted_at IS NULL
   AND p.status = 'active'
   AND p.version IS NOT NULL
   AND (p.version != ?1 OR COALESCE(p.artifact_sha256, '') != ?2)
   AND u.is_blocked = 0`;

/** Outdated panels owned by one user, oldest install first. */
export async function listOutdatedForUser(env: Env, input: {
  userId: number;
  latestVersion: string;
  expectedSha256: string;
  limit?: number;
}): Promise<BatchOutdatedRow[]> {
  return all<BatchOutdatedRow>(
    env,
    `SELECT p.id, p.user_id, p.worker_name, p.version, u.telegram_id AS user_telegram_id
     ${OUTDATED_BASE}
       AND p.user_id = ?3
     ORDER BY p.id ASC
     LIMIT ?4`,
    input.latestVersion,
    input.expectedSha256,
    input.userId,
    Math.max(1, input.limit ?? 50),
  );
}

/** Outdated panels across every tenant (admin bulk update / cron auto-apply). */
export async function listOutdatedAll(env: Env, input: {
  latestVersion: string;
  expectedSha256: string;
  limit?: number;
}): Promise<BatchOutdatedRow[]> {
  return all<BatchOutdatedRow>(
    env,
    `SELECT p.id, p.user_id, p.worker_name, p.version, u.telegram_id AS user_telegram_id
     ${OUTDATED_BASE}
     ORDER BY p.id ASC
     LIMIT ?3`,
    input.latestVersion,
    input.expectedSha256,
    Math.max(1, input.limit ?? 200),
  );
}

/** How many of the user's opened panels are behind the latest version/build. */
export async function countOutdatedForUser(
  env: Env,
  userId: number,
  latestVersion: string,
  expectedSha256: string,
): Promise<number> {
  const value = await scalar(
    env,
    `SELECT COUNT(*) ${OUTDATED_BASE} AND p.user_id = ?3`,
    latestVersion,
    expectedSha256,
    userId,
  );
  return Number(value ?? 0);
}

/** How many opened panels system-wide are behind the latest version/build. */
export async function countOutdatedAll(env: Env, latestVersion: string, expectedSha256: string): Promise<number> {
  const value = await scalar(env, `SELECT COUNT(*) ${OUTDATED_BASE}`, latestVersion, expectedSha256);
  return Number(value ?? 0);
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

export async function activeVersions(env: Env): Promise<PanelVersion[]> {
  return all<PanelVersion>(env, "SELECT * FROM panel_versions WHERE is_active = 1 ORDER BY created_at DESC");
}

export async function findVersion(env: Env, version: string): Promise<PanelVersion | null> {
  return one<PanelVersion>(env, "SELECT * FROM panel_versions WHERE version = ?", version);
}

export async function registerVersion(env: Env, input: {
  version: string;
  artifactKey: string;
  artifactSha256: string;
  compatibilityDate: string;
  notes: string | null;
  changelogFa?: string | null;
  isActive: boolean;
}): Promise<void> {
  await run(
    env,
    `INSERT INTO panel_versions (version, artifact_key, artifact_sha256, compatibility_date, notes, changelog_fa, is_active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (version) DO UPDATE SET
       artifact_key = excluded.artifact_key,
       artifact_sha256 = excluded.artifact_sha256,
       compatibility_date = excluded.compatibility_date,
       notes = excluded.notes,
       changelog_fa = excluded.changelog_fa,
       is_active = excluded.is_active`,
    input.version,
    input.artifactKey,
    input.artifactSha256,
    input.compatibilityDate,
    input.notes,
    input.changelogFa ?? null,
    input.isActive ? 1 : 0,
    now(),
  );
}

export async function setVersionActive(env: Env, version: string, active: boolean): Promise<void> {
  await run(env, "UPDATE panel_versions SET is_active = ? WHERE version = ?", active ? 1 : 0, version);
}

// ---------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------

export interface PanelBackup {
  id: number;
  panel_id: number;
  user_id: number;
  object_key: string | null;
  size_bytes: number | null;
  checksum: string | null;
  status: string;
  created_at: number;
  expires_at: number | null;
  error: string | null;
}

export async function createBackup(env: Env, panelId: number, userId: number): Promise<number> {
  await run(
    env,
    `INSERT INTO panel_backups (panel_id, user_id, status, created_at) VALUES (?, ?, 'pending', ?)`,
    panelId,
    userId,
    now(),
  );
  const row = await one<{ id: number }>(
    env,
    "SELECT id FROM panel_backups WHERE panel_id = ? ORDER BY id DESC LIMIT 1",
    panelId,
  );
  return Number(row?.id ?? 0);
}

export async function completeBackup(env: Env, backupId: number, input: {
  objectKey: string;
  sizeBytes: number;
  checksum: string;
  expiresAt: number | null;
}): Promise<void> {
  await run(
    env,
    `UPDATE panel_backups SET status = 'completed', object_key = ?, size_bytes = ?, checksum = ?, expires_at = ?
      WHERE id = ?`,
    input.objectKey,
    input.sizeBytes,
    input.checksum,
    input.expiresAt,
    backupId,
  );
}

export async function failBackup(env: Env, backupId: number, error: string): Promise<void> {
  await run(env, "UPDATE panel_backups SET status = 'failed', error = ? WHERE id = ?", error.slice(0, 300), backupId);
}

export async function listBackups(env: Env, panelId: number, userId: number): Promise<PanelBackup[]> {
  return all<PanelBackup>(
    env,
    "SELECT * FROM panel_backups WHERE panel_id = ? AND user_id = ? ORDER BY id DESC LIMIT 20",
    panelId,
    userId,
  );
}

export async function findBackup(env: Env, backupId: number, userId: number): Promise<PanelBackup | null> {
  return one<PanelBackup>(env, "SELECT * FROM panel_backups WHERE id = ? AND user_id = ?", backupId, userId);
}

/** Restores are destructive: expiring old backups keeps storage bounded. */
export async function pruneBackups(env: Env): Promise<number> {
  const rows = await all<{ id: number; object_key: string | null }>(
    env,
    "SELECT id, object_key FROM panel_backups WHERE expires_at IS NOT NULL AND expires_at < ?",
    now(),
  );
  if (!rows.length) return 0;
  await batch(
    env,
    rows.map((row) => stmt("DELETE FROM panel_backups WHERE id = ?", row.id)),
  );
  return rows.length;
}
