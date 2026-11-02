/** Workers scripts, schedules and the workers.dev subdomain. */

import { CloudflareClient } from "./client";
import { TIMEOUTS } from "../config/constants";
import { AppError, messages } from "../utils/errors";

export interface WorkerBinding {
  type: "plain_text" | "secret_text" | "d1" | "kv_namespace" | "r2_bucket";
  name: string;
  text?: string;
  id?: string;
  database_id?: string;
  namespace_id?: string;
  bucket_name?: string;
}

export interface UploadResult {
  id: string;
  etag?: string;
  deployment_id?: string;
  handlers?: string[];
  modified_on?: string;
}

export interface ScriptSummary {
  id: string;
  created_on?: string;
  modified_on?: string;
  etag?: string;
}

export interface SubdomainState {
  enabled: boolean;
  previews_enabled: boolean;
}

/**
 * PUT /accounts/{id}/workers/scripts/{name}
 * Multipart upload with a JSON metadata part; `main_module` is required for
 * module-syntax Workers, and bindings (including secret_text) travel inside the
 * metadata so a fresh script is fully configured in one atomic call.
 */
export async function uploadScript(
  client: CloudflareClient,
  accountId: string,
  scriptName: string,
  input: {
    moduleSource: string;
    mainModule: string;
    compatibilityDate: string;
    bindings: WorkerBinding[];
    compatibilityFlags?: string[];
    observability?: boolean;
  },
): Promise<UploadResult> {
  const metadata: Record<string, unknown> = {
    main_module: input.mainModule,
    compatibility_date: input.compatibilityDate,
    bindings: input.bindings,
  };
  if (input.compatibilityFlags?.length) metadata.compatibility_flags = input.compatibilityFlags;
  if (input.observability !== false) metadata.observability = { enabled: true };

  const form = new FormData();
  form.append("metadata", JSON.stringify(metadata));
  form.append(
    input.mainModule,
    new Blob([input.moduleSource], { type: "application/javascript+module" }),
    input.mainModule,
  );

  const envelope = await client.request<UploadResult>(`/accounts/${accountId}/workers/scripts/${scriptName}`, {
    method: "PUT",
    formData: form,
    timeoutMs: TIMEOUTS.cloudflareUploadMs,
    retries: 1,
  });
  return envelope.result;
}

/** DELETE /accounts/{id}/workers/scripts/{name} — idempotent by design. */
export async function deleteScript(client: CloudflareClient, accountId: string, scriptName: string): Promise<boolean> {
  try {
    await client.request<null>(`/accounts/${accountId}/workers/scripts/${scriptName}`, {
      method: "DELETE",
      retries: 1,
    });
    return true;
  } catch (error) {
    if (error instanceof AppError && error.code === "CF_NOT_FOUND") return false;
    throw error;
  }
}

export async function scriptExists(client: CloudflareClient, accountId: string, scriptName: string): Promise<boolean> {
  const scripts = await client.paginate<ScriptSummary>(`/accounts/${accountId}/workers/scripts`, 5);
  return scripts.some((script) => script.id === scriptName);
}

/** POST /accounts/{id}/workers/scripts/{name}/subdomain — publish on workers.dev. */
export async function enableWorkersDev(
  client: CloudflareClient,
  accountId: string,
  scriptName: string,
): Promise<SubdomainState> {
  const envelope = await client.request<SubdomainState>(
    `/accounts/${accountId}/workers/scripts/${scriptName}/subdomain`,
    { method: "POST", body: { enabled: true, previews_enabled: false }, retries: 2 },
  );
  return envelope.result;
}

export async function workersDevState(
  client: CloudflareClient,
  accountId: string,
  scriptName: string,
): Promise<SubdomainState> {
  const envelope = await client.request<SubdomainState>(
    `/accounts/${accountId}/workers/scripts/${scriptName}/subdomain`,
  );
  return envelope.result;
}

/**
 * GET /accounts/{id}/workers/subdomain — the account-level `<subdomain>.workers.dev`.
 * Returns null when the account has never claimed one; `ensureAccountSubdomain`
 * then claims a derived name so the panel URL can exist.
 */
export async function getAccountSubdomain(client: CloudflareClient, accountId: string): Promise<string | null> {
  try {
    const envelope = await client.request<{ subdomain: string }>(`/accounts/${accountId}/workers/subdomain`);
    return envelope.result?.subdomain ?? null;
  } catch (error) {
    if (error instanceof AppError && (error.code === "CF_NOT_FOUND" || error.code === "CF_FORBIDDEN")) return null;
    throw error;
  }
}

/** PUT /accounts/{id}/workers/subdomain — claims the account workers.dev subdomain. */
export async function createAccountSubdomain(
  client: CloudflareClient,
  accountId: string,
  subdomain: string,
): Promise<string> {
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(subdomain)) {
    throw new AppError("VALIDATION_FAILED", messages.validation, { detail: "invalid workers.dev subdomain" });
  }
  const envelope = await client.request<{ subdomain: string }>(`/accounts/${accountId}/workers/subdomain`, {
    method: "PUT",
    body: { subdomain },
    retries: 1,
  });
  return envelope.result?.subdomain ?? subdomain;
}

/** PUT /accounts/{id}/workers/scripts/{name}/schedules — replaces the cron list. */
export async function setSchedule(
  client: CloudflareClient,
  accountId: string,
  scriptName: string,
  cron: string | null,
): Promise<void> {
  await client.request<unknown>(`/accounts/${accountId}/workers/scripts/${scriptName}/schedules`, {
    method: "PUT",
    body: cron ? [{ cron }] : [],
    retries: 1,
  });
}

export async function getSchedules(client: CloudflareClient, accountId: string, scriptName: string): Promise<string[]> {
  const envelope = await client.request<{ schedules: Array<{ cron: string }> }>(
    `/accounts/${accountId}/workers/scripts/${scriptName}/schedules`,
  );
  return (envelope.result?.schedules ?? []).map((entry) => entry.cron);
}
