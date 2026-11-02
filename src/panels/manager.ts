/**
 * Read-model helpers for panels.
 *
 * The bot and the dashboard both render panels, so the mapping from database
 * rows to display values lives here — once — to keep the two surfaces
 * consistent and to keep all tenant scoping in one place.
 */

import type { Env } from "../config/env";
import * as panelsRepo from "../database/repositories/panels";
import type { Panel } from "../database/repositories/panels";
import * as accountsRepo from "../database/repositories/accounts";
import * as jobsRepo from "../database/repositories/jobs";
import { formatDateFa, formatRelativeFa, toPersianDigits } from "../utils/time";
import { statusLabelFa } from "../bot/keyboards";

export interface PanelView {
  id: number;
  uid: string;
  workerName: string;
  status: string;
  statusLabel: string;
  version: string;
  url: string | null;
  accountName: string;
  health: string;
  installedAt: string;
  updatedAt: string;
  databaseName: string;
  activeJobId: string | null;
}

export async function view(env: Env, panel: Panel): Promise<PanelView> {
  const account = await accountsRepo.findForUser(env, panel.user_id, panel.account_ref);
  const activeJob = await jobsRepo.activeJobForPanel(env, panel.id);
  return {
    id: panel.id,
    uid: panel.uid,
    workerName: panel.worker_name,
    status: panel.status,
    statusLabel: statusLabelFa(panel.status),
    version: panel.version ?? "—",
    url: panel.panel_url,
    accountName: account?.account_name ?? "—",
    health: panel.last_health_status
      ? `${panel.last_health_status === "ok" ? "✅ سالم" : "⚠️ نیازمند بررسی"} (${toPersianDigits(panel.last_health_latency_ms ?? 0)}ms) — ${formatRelativeFa(panel.last_health_check_at)}`
      : "بررسی نشده",
    installedAt: formatDateFa(panel.installed_at),
    updatedAt: formatDateFa(panel.updated_at),
    databaseName: panel.d1_database_name,
    activeJobId: activeJob?.id ?? null,
  };
}

export async function viewForUser(env: Env, userId: number, panelId: number): Promise<PanelView | null> {
  const panel = await panelsRepo.findForUser(env, userId, panelId);
  if (!panel) return null;
  return view(env, panel);
}

export async function listViewsForUser(env: Env, userId: number): Promise<PanelView[]> {
  const panels = await panelsRepo.listForUser(env, userId);
  return Promise.all(panels.map((panel) => view(env, panel)));
}

export async function listAllViews(env: Env): Promise<PanelView[]> {
  const rows = await panelsRepo.listAll(env, { limit: 100, offset: 0 });
  return Promise.all(rows.map((panel) => view(env, panel)));
}

/** Aggregate health used by the user-facing status screen. */
export async function healthSummary(env: Env, userId: number): Promise<{ healthy: number; degraded: number; unknown: number }> {
  const panels = await panelsRepo.listForUser(env, userId);
  let healthy = 0;
  let degraded = 0;
  let unknown = 0;
  for (const panel of panels) {
    if (panel.last_health_status === "ok") healthy += 1;
    else if (panel.last_health_status) degraded += 1;
    else unknown += 1;
  }
  return { healthy, degraded, unknown };
}

/**
 * Recovery key disclosure.
 *
 * The key is sealed with a context bound to (user, panel). It is returned only
 * to the owning user, only on explicit request, and the read is audited by the
 * caller. Returns null when the panel never stored one.
 */
export async function revealRecoveryKey(
  env: Env,
  userId: number,
  panelId: number,
): Promise<{ recoveryKey: string | null }> {
  const panel = await panelsRepo.findForUser(env, userId, panelId);
  if (!panel?.recovery_key_sealed) return { recoveryKey: null };
  const { unseal, credentialContext } = await import("../security/crypto");
  try {
    const sealed = JSON.parse(panel.recovery_key_sealed) as { ciphertext: string; iv: string; keyVersion: number };
    const key = await unseal(
      sealed,
      credentialContext(userId, panel.id, "panel_recovery_key"),
      env.CREDENTIAL_ENCRYPTION_KEY,
      env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS,
    );
    return { recoveryKey: key };
  } catch {
    return { recoveryKey: null };
  }
}
