/**
 * Step implementations for the provisioning engine.
 *
 * Contract for every step:
 *   1. idempotent — running it twice with the same job payload is safe;
 *   2. resumable — anything the next step needs is written back through
 *      `ctx.merge()` before the step returns;
 *   3. honest — a step reports `{ message }` on success and throws on failure,
 *      never swallows a Cloudflare error.
 */

import type { Env, PublicConfig } from "../config/env";
import { PANEL, TIMEOUTS } from "../config/constants";
import type { CloudflareClient } from "../cloudflare/client";
import * as workersApi from "../cloudflare/workers";
import * as d1Api from "../cloudflare/d1";
import type { CloudflareAccount } from "../database/repositories/accounts";
import type { Job } from "../database/repositories/jobs";
import type { Panel } from "../database/repositories/panels";
import * as panelsRepo from "../database/repositories/panels";
import { probe, summarize } from "../cloudflare/permissions";
import type { ArtifactStore, PanelArtifact } from "../panels/artifact";
import { AppError, messages } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { seal, unseal, credentialContext } from "../security/crypto";
import { sha256Hex, recoveryKey as newRecoveryKey } from "../utils/ids";

export interface InstallPayload {
  workerName: string;
  databaseName: string;
  version: string;
  accountRef: number;
  cloudflareAccountId: string;
  /** filled in as the job progresses */
  d1DatabaseId?: string;
  subdomain?: string;
  artifactSha256?: string;
  recoveryKey?: string;
  apiToken?: string;
  panelUrl?: string;
  previousVersion?: string;
  previousSha?: string;
  backupId?: number;
  restoreObjectKey?: string;
  backupChecksum?: string;
  backupBytes?: number;
}

export interface JobContext {
  env: Env;
  config: PublicConfig;
  logger: Logger;
  job: Job;
  panel: Panel;
  account: CloudflareAccount;
  client: CloudflareClient;
  artifacts: ArtifactStore;
  payload: InstallPayload;
  merge(patch: Partial<InstallPayload>): Promise<void>;
}

export interface StepOutcome {
  message: string;
}

type StepFn = (ctx: JobContext) => Promise<StepOutcome>;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function loadArtifact(ctx: JobContext): Promise<PanelArtifact> {
  const version = ctx.payload.version;
  const registered = await panelsRepo.findVersion(ctx.env, version);
  if (!registered) {
    throw new AppError("ARTIFACT_MISSING", `نسخهٔ ${version} پنل در فهرست نسخه‌های مجاز نیست.`, {
      detail: `panel_versions has no row for ${version}`,
    });
  }
  if (!registered.is_active) {
    throw new AppError("ARTIFACT_MISSING", `نسخهٔ ${version} پنل غیرفعال شده است.`);
  }
  return ctx.artifacts.load(registered.version, registered.artifact_sha256, registered.artifact_key);
}

function panelUrl(subdomain: string, workerName: string): string {
  return `https://${workerName}.${subdomain}.workers.dev/panel`;
}

function panelRootUrl(subdomain: string, workerName: string): string {
  return `https://${workerName}.${subdomain}.workers.dev/`;
}

/** Builds the binding list the audited panel expects (D1 `DB` + optional vars/secrets). */
export function buildBindings(
  ctx: JobContext,
  databaseId: string,
  secrets: { recoveryKey?: string; apiToken?: string },
): workersApi.WorkerBinding[] {
  const bindings: workersApi.WorkerBinding[] = [
    { type: "d1", name: PANEL.d1BindingName, id: databaseId, database_id: databaseId },
    { type: "plain_text", name: "PANEL_TITLE", text: ctx.config.environment === "production" ? "Bee.Hive Panel" : "Bee.Hive Panel (staging)" },
  ];
  if (secrets.recoveryKey) bindings.push({ type: "secret_text", name: "RECOVERY_KEY", text: secrets.recoveryKey });
  if (secrets.apiToken) bindings.push({ type: "secret_text", name: "PANEL_API_TOKEN", text: secrets.apiToken });
  return bindings;
}

// ---------------------------------------------------------------------------
// install / update steps
// ---------------------------------------------------------------------------

const validateAccount: StepFn = async (ctx) => {
  const report = await probe(ctx.client, ctx.account.cloudflare_account_id);
  if (!report.ok) {
    throw new AppError("PERMISSION_MISSING", messages.permissionMissing, {
      detail: `missing: ${report.missing.join(",")}`,
    });
  }
  return { message: summarize(report) };
};

const ensureSubdomain: StepFn = async (ctx) => {
  const existing = await workersApi.getAccountSubdomain(ctx.client, ctx.account.cloudflare_account_id);
  if (existing) {
    await ctx.merge({ subdomain: existing });
    return { message: existing };
  }
  // The account never claimed a workers.dev subdomain. Claim one derived from
  // the account name so the panel gets a stable, human-readable URL.
  const base = ctx.account.account_name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const candidate = (base || "beehive") + "-" + ctx.account.cloudflare_account_id.slice(0, 6);
  const created = await workersApi.createAccountSubdomain(ctx.client, ctx.account.cloudflare_account_id, candidate);
  await ctx.merge({ subdomain: created });
  return { message: created };
};

const createDatabase: StepFn = async (ctx) => {
  const { database, created } = await d1Api.ensureDatabase(
    ctx.client,
    ctx.account.cloudflare_account_id,
    ctx.payload.databaseName,
  );
  await ctx.merge({ d1DatabaseId: database.uuid });
  await panelsRepo.addResource(ctx.env, {
    panelId: ctx.panel.id,
    kind: "d1_database",
    externalId: database.uuid,
    meta: JSON.stringify({ name: database.name }),
  });
  return { message: created ? `D1 ${database.name} created (${database.uuid})` : `D1 ${database.name} reused` };
};

const uploadWorker: StepFn = async (ctx) => {
  const artifact = await loadArtifact(ctx);
  const databaseId = ctx.payload.d1DatabaseId ?? ctx.panel.d1_database_id;
  if (!databaseId) {
    throw new AppError("INTERNAL", messages.internal, { detail: "d1 database id missing at upload step" });
  }

  // The recovery key is generated once per panel and sealed; on redeploy the
  // stored value is reused so the operator's key never silently changes.
  let recoveryKey = ctx.payload.recoveryKey ?? (await readSealedRecoveryKey(ctx)) ?? "";
  const generated = !recoveryKey;
  if (generated) recoveryKey = newRecoveryKey();

  const result = await workersApi.uploadScript(
    ctx.client,
    ctx.account.cloudflare_account_id,
    ctx.payload.workerName,
    {
      moduleSource: artifact.source,
      mainModule: PANEL.mainModule,
      compatibilityDate: ctx.config.panelCompatibilityDate,
      bindings: buildBindings(ctx, databaseId, { recoveryKey }),
    },
  );

  await panelsRepo.addResource(ctx.env, {
    panelId: ctx.panel.id,
    kind: "worker_script",
    externalId: ctx.payload.workerName,
    meta: JSON.stringify({ etag: result.etag ?? null, deployment_id: result.deployment_id ?? null }),
  });

  if (generated) {
    const sealedKey = await seal(
      recoveryKey,
      credentialContext(ctx.job.user_id, ctx.panel.id, "panel_recovery_key"),
      ctx.env.CREDENTIAL_ENCRYPTION_KEY,
    );
    await panelsRepo.savePanelSecrets(ctx.env, ctx.panel.id, { recoveryKeySealed: JSON.stringify(sealedKey) });
    await ctx.merge({ recoveryKey });
  }

  await panelsRepo.setArtifact(ctx.env, ctx.panel.id, {
    version: artifact.version,
    artifactSha256: artifact.sha256,
    d1DatabaseId: databaseId,
  });
  await ctx.merge({ artifactSha256: artifact.sha256 });

  return {
    message: `uploaded ${(artifact.bytes / 1024).toFixed(0)} KB, sha256 ${artifact.sha256.slice(0, 12)}…`,
  };
};

/** Reads the sealed recovery key back so a redeploy keeps the same key. */
async function readSealedRecoveryKey(ctx: JobContext): Promise<string | null> {
  const panel = await panelsRepo.findById(ctx.env, ctx.panel.id);
  if (!panel?.recovery_key_sealed) return null;
  try {
    const sealed = JSON.parse(panel.recovery_key_sealed) as { ciphertext: string; iv: string; keyVersion: number };
    if (!sealed?.ciphertext || !sealed?.iv) return null;
    return await unseal(
      sealed,
      credentialContext(ctx.job.user_id, panel.id, "panel_recovery_key"),
      ctx.env.CREDENTIAL_ENCRYPTION_KEY,
      ctx.env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS,
    );
  } catch {
    return null;
  }
}

const enableWorkersDev: StepFn = async (ctx) => {
  const state = await workersApi.enableWorkersDev(ctx.client, ctx.account.cloudflare_account_id, ctx.payload.workerName);
  if (!state.enabled) {
    throw new AppError("CF_ERROR", "فعال‌سازی دامنهٔ workers.dev ناموفق بود.", { detail: "subdomain not enabled" });
  }
  await panelsRepo.addResource(ctx.env, {
    panelId: ctx.panel.id,
    kind: "workers_dev",
    externalId: ctx.payload.workerName,
  });
  return { message: "workers.dev enabled" };
};

const configureSchedule: StepFn = async (ctx) => {
  await workersApi.setSchedule(ctx.client, ctx.account.cloudflare_account_id, ctx.payload.workerName, ctx.config.panelCron);
  await panelsRepo.addResource(ctx.env, {
    panelId: ctx.panel.id,
    kind: "cron_trigger",
    externalId: ctx.config.panelCron,
  });
  return { message: `cron ${ctx.config.panelCron}` };
};

const verifyEndpoint: StepFn = async (ctx) => {
  const subdomain = ctx.payload.subdomain ?? ctx.account.workers_subdomain;
  const existing = ctx.panel.panel_url ?? ctx.payload.panelUrl ?? null;
  if (!subdomain && !existing) {
    throw new AppError("INTERNAL", messages.internal, { detail: "workers subdomain unknown" });
  }

  const url = subdomain ? panelUrl(subdomain, ctx.payload.workerName) : (existing as string);
  const rootUrl = subdomain ? panelRootUrl(subdomain, ctx.payload.workerName) : (existing as string);
  await ctx.merge({ panelUrl: url });

  // Fresh deployments need a moment to propagate to every edge.
  let lastError = "";
  for (let attempt = 0; attempt < ctx.config.panelVerifyAttempts; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, ctx.config.panelVerifyIntervalMs * attempt));
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUTS.verifyMs);
      const response = await fetch(rootUrl, { signal: controller.signal });
      clearTimeout(timer);
      const body = await response.text();
      if (response.ok && body.includes(PANEL.healthMarker)) {
        return { message: `HTTP ${response.status} at ${url}` };
      }
      lastError = `HTTP ${response.status}${body.includes(PANEL.healthMarker) ? "" : " (marker missing)"}`;
    } catch (error) {
      lastError = (error as Error)?.name === "AbortError" ? "timeout" : String((error as Error)?.message ?? error);
    }
  }
  throw new AppError("CF_ERROR", "پنل پس از استقرار پاسخ سالم نداد.", { detail: `verify failed: ${lastError}` });
};

const finalize: StepFn = async (ctx) => {
  const fresh = await panelsRepo.findById(ctx.env, ctx.panel.id);
  const artifactSha = ctx.payload.artifactSha256 ?? fresh?.artifact_sha256 ?? "";
  const url = ctx.payload.panelUrl ?? fresh?.panel_url ?? "";
  const databaseId = ctx.payload.d1DatabaseId ?? fresh?.d1_database_id ?? "";
  await panelsRepo.markInstalled(ctx.env, ctx.panel.id, {
    panelUrl: url,
    d1DatabaseId: databaseId,
    artifactSha256: artifactSha,
    version: ctx.payload.version,
    recoveryKeySealed: fresh?.recovery_key_sealed ?? null,
    apiTokenSealed: fresh?.api_token_sealed ?? null,
    cronSchedule: ctx.config.panelCron,
  });
  return { message: "panel record updated" };
};

// ---------------------------------------------------------------------------
// delete steps
// ---------------------------------------------------------------------------

const deletePreflight: StepFn = async (ctx) => {
  const resources = await panelsRepo.liveResourcesOf(ctx.env, ctx.panel.id);
  if (!resources.length) {
    // Nothing was ever recorded — refuse rather than guess at account resources.
    throw new AppError("CONFLICT", "منابع ثبت‌شده‌ای برای این پنل پیدا نشد؛ حذف انجام نشد.", {
      detail: "no tracked resources",
    });
  }
  return { message: `${resources.length} resource(s) tracked` };
};

const deleteWorker: StepFn = async (ctx) => {
  const resources = await panelsRepo.liveResourcesOf(ctx.env, ctx.panel.id);
  const workerResources = resources.filter((resource) => resource.kind === "worker_script");
  if (!workerResources.length) return { message: "no worker tracked — skipped" };

  for (const resource of workerResources) {
    // Ownership check: only the script name recorded for THIS panel is touched.
    if (resource.external_id !== ctx.panel.worker_name) {
      throw new AppError("FORBIDDEN", messages.forbidden, {
        detail: `resource ${resource.external_id} does not belong to panel ${ctx.panel.worker_name}`,
      });
    }
    const removed = await workersApi.deleteScript(ctx.client, ctx.account.cloudflare_account_id, resource.external_id);
    await panelsRepo.markResourceDeleted(ctx.env, ctx.panel.id, "worker_script", resource.external_id);
    ctx.logger.info("worker deleted", { worker: resource.external_id, removed });
  }
  return { message: "worker deleted" };
};

const deleteDatabase: StepFn = async (ctx) => {
  const resources = await panelsRepo.liveResourcesOf(ctx.env, ctx.panel.id);
  const databases = resources.filter((resource) => resource.kind === "d1_database");
  if (!databases.length) return { message: "no database tracked — skipped" };

  for (const resource of databases) {
    if (resource.external_id !== ctx.panel.d1_database_id) {
      throw new AppError("FORBIDDEN", messages.forbidden, {
        detail: `database ${resource.external_id} does not belong to the panel record`,
      });
    }
    await d1Api.deleteDatabase(ctx.client, ctx.account.cloudflare_account_id, resource.external_id);
    await panelsRepo.markResourceDeleted(ctx.env, ctx.panel.id, "d1_database", resource.external_id);
  }
  return { message: "database deleted" };
};

const markDeleted: StepFn = async (ctx) => {
  await panelsRepo.markDeleted(ctx.env, ctx.panel.id, "deleted_by_owner");
  return { message: "panel archived" };
};

// ---------------------------------------------------------------------------
// backup / restore / health
// ---------------------------------------------------------------------------

const backupPreflight: StepFn = async (ctx) => {
  if (!ctx.panel.d1_database_id) {
    throw new AppError("CONFLICT", "شناسهٔ پایگاه دادهٔ این پنل ثبت نشده است.", { detail: "d1_database_id null" });
  }
  if (!ctx.env.ARTIFACTS) {
    throw new AppError("ARTIFACT_MISSING", "مخزن فایل (R2) تنظیم نشده است؛ پشتیبان‌گیری در دسترس نیست.");
  }
  return { message: "ok" };
};

/** Deterministic object key: re-running the step overwrites its own dump. */
export function backupObjectKey(panelUid: string, jobId: string): string {
  return `backups/${panelUid}/${jobId}.sql`;
}

const exportDatabase: StepFn = async (ctx) => {
  const databaseId = ctx.panel.d1_database_id;
  if (!databaseId) throw new AppError("CONFLICT", "شناسهٔ پایگاه داده موجود نیست.");
  if (!ctx.env.ARTIFACTS) throw new AppError("ARTIFACT_MISSING", "مخزن فایل تنظیم نشده است.");

  const signedUrl = await d1Api.exportDatabase(ctx.client, ctx.account.cloudflare_account_id, databaseId);
  const sql = await d1Api.downloadExport(signedUrl);
  const checksum = await sha256Hex(sql);
  const objectKey = backupObjectKey(ctx.panel.uid, ctx.job.id);

  await ctx.env.ARTIFACTS.put(objectKey, sql, {
    httpMetadata: { contentType: "application/sql" },
    customMetadata: { panel: ctx.panel.uid, checksum, job: ctx.job.id },
  });
  await ctx.merge({ restoreObjectKey: objectKey, backupChecksum: checksum, backupBytes: sql.length });
  return { message: `${(sql.length / 1024).toFixed(0)} KB exported` };
};

const storeBackup: StepFn = async (ctx) => {
  const backupId = ctx.payload.backupId;
  if (!backupId) throw new AppError("INTERNAL", messages.internal, { detail: "backup id missing from job payload" });
  const objectKey = ctx.payload.restoreObjectKey;
  if (!objectKey) throw new AppError("INTERNAL", messages.internal, { detail: "object key missing (export step not run)" });
  await panelsRepo.completeBackup(ctx.env, backupId, {
    objectKey,
    sizeBytes: Number(ctx.payload.backupBytes ?? 0),
    checksum: ctx.payload.backupChecksum ?? "",
    expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
  });
  return { message: `backup #${backupId} stored` };
};

const restoreDatabase: StepFn = async (ctx) => {
  const databaseId = ctx.panel.d1_database_id;
  const objectKey = ctx.payload.restoreObjectKey;
  if (!databaseId) throw new AppError("CONFLICT", "شناسهٔ پایگاه داده موجود نیست.");
  if (!objectKey) throw new AppError("CONFLICT", "نسخهٔ پشتیبان انتخاب نشده است.");
  if (!ctx.env.ARTIFACTS) throw new AppError("ARTIFACT_MISSING", "مخزن فایل (R2) تنظیم نشده است.");
  const object = await ctx.env.ARTIFACTS.get(objectKey);
  if (!object) throw new AppError("NOT_FOUND", messages.backupEmpty, { detail: `missing R2 object ${objectKey}` });
  const sql = await object.text();
  await d1Api.importDatabase(ctx.client, ctx.account.cloudflare_account_id, databaseId, sql);
  return { message: `restored ${(sql.length / 1024).toFixed(0)} KB` };
};

const healthCheck: StepFn = async (ctx) => {
  const url = ctx.panel.panel_url;
  if (!url) throw new AppError("CONFLICT", "آدرس پنل ثبت نشده است.");
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUTS.verifyMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const body = await response.text();
    const latency = Date.now() - started;
    const healthy = response.ok && body.includes(PANEL.healthMarker);
    await panelsRepo.recordHealth(ctx.env, ctx.panel.id, { status: healthy ? "ok" : "degraded", latencyMs: latency });
    return { message: healthy ? `ok in ${latency}ms` : `degraded (HTTP ${response.status})` };
  } finally {
    clearTimeout(timer);
  }
};

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

export const STEPS: Record<string, StepFn> = {
  validate_account: validateAccount,
  ensure_subdomain: ensureSubdomain,
  create_database: createDatabase,
  upload_worker: uploadWorker,
  enable_workers_dev: enableWorkersDev,
  configure_schedule: configureSchedule,
  verify_endpoint: verifyEndpoint,
  finalize,
  preflight: deletePreflight,
  delete_worker: deleteWorker,
  delete_database: deleteDatabase,
  mark_deleted: markDeleted,
  export_database: exportDatabase,
  store_backup: storeBackup,
  restore_database: restoreDatabase,
  health_check: healthCheck,
};

export function stepFor(name: string): StepFn {
  const step = STEPS[name];
  if (!step) throw new AppError("INTERNAL", messages.internal, { detail: `unknown step ${name}` });
  return step;
}

/** Backup jobs need a preflight that checks the D1 id instead of tracked resources. */
export function stepForJob(job: Job, name: string): StepFn {
  if (job.kind === "backup" && name === "preflight") return backupPreflight;
  if (job.kind === "restore" && name === "preflight") return backupPreflight;
  return stepFor(name);
}
