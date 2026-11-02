/**
 * Capability probing.
 *
 * Cloudflare exposes no endpoint that lists the scopes of a *token you hold*
 * (that requires API Tokens:Read, a permission we deliberately do not ask
 * customers for). The documented, least-privilege-safe way to verify that a
 * token can do what provisioning needs is to call the exact read endpoints the
 * provisioning engine will use and inspect the result:
 *
 *   Workers Scripts:Edit   → GET /accounts/{id}/workers/scripts
 *   D1:Edit                → GET /accounts/{id}/d1/database
 *   Account Settings:Read  → GET /accounts/{id}
 *
 * A 403 on any of them means the token is missing that permission; anything
 * else (200) means the capability is present. No write operation is performed
 * during the probe.
 */

import type { CloudflareClient } from "./client";
import { AppError } from "../utils/errors";

export interface PermissionProbe {
  key: "workers_scripts" | "d1" | "account_settings";
  label: string;
  granted: boolean;
  reason: string;
}

export interface PermissionReport {
  ok: boolean;
  probes: PermissionProbe[];
  missing: string[];
}

const PROBES: Array<Omit<PermissionProbe, "granted" | "reason"> & { path: (accountId: string) => string }> = [
  {
    key: "workers_scripts",
    label: "Workers Scripts:Edit",
    path: (accountId) => `/accounts/${accountId}/workers/scripts?per_page=1`,
  },
  {
    key: "d1",
    label: "D1:Edit",
    path: (accountId) => `/accounts/${accountId}/d1/database?per_page=1`,
  },
  {
    key: "account_settings",
    label: "Account Settings:Read",
    path: (accountId) => `/accounts/${accountId}`,
  },
];

export async function probe(cpuClient: CloudflareClient, accountId: string): Promise<PermissionReport> {
  const client: CloudflareClient = cpuClient;
  const probes: PermissionProbe[] = [];

  for (const definition of PROBES) {
    try {
      await client.request<unknown>(definition.path(accountId), { retries: 1 });
      probes.push({ key: definition.key, label: definition.label, granted: true, reason: "ok" });
    } catch (error) {
      const appError = error instanceof AppError ? error : null;
      const reason = appError?.code ?? "UNKNOWN";
      const granted = reason !== "CF_FORBIDDEN" && reason !== "CF_UNAUTHORIZED";
      // Network hiccups must not be reported as "permission missing".
      probes.push({
        key: definition.key,
        label: definition.label,
        granted,
        reason: granted ? `unverified:${reason}` : reason,
      });
    }
  }

  const missing = probes.filter((entry) => !entry.granted).map((entry) => entry.label);
  return { ok: missing.length === 0, probes, missing };
}

/** Human-readable summary stored on the account row. */
export function summarize(report: PermissionReport): string {
  return report.probes.map((entry) => `${entry.label}=${entry.granted ? "ok" : entry.reason}`).join("; ");
}
