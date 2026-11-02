/**
 * Panel health checks.
 *
 * A health check is a plain HTTPS GET against the panel's own URL — the panel
 * is a normal Worker on the customer account, so the bot does not need (and does
 * not use) the customer's API token for this. The marker asserted is the one
 * present in the audited bundle's HTML (`Bee.Hive`).
 */

import type { Env } from "../config/env";
import { PANEL, TIMEOUTS } from "../config/constants";
import * as panelsRepo from "../database/repositories/panels";
import type { Panel } from "../database/repositories/panels";

export interface HealthResult {
  ok: boolean;
  statusCode: number | null;
  latencyMs: number;
  reason: string;
}

export async function check(panel: Panel): Promise<HealthResult> {
  if (!panel.panel_url) {
    return { ok: false, statusCode: null, latencyMs: 0, reason: "آدرس پنل ثبت نشده است." };
  }
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUTS.verifyMs);
  try {
    const response = await fetch(panel.panel_url, {
      signal: controller.signal,
      headers: { "Cache-Control": "no-cache" },
      redirect: "manual",
    });
    const latencyMs = Date.now() - started;
    // The panel answers /panel with a redirect to /login when unauthenticated.
    if (response.status >= 300 && response.status < 400) {
      return { ok: true, statusCode: response.status, latencyMs, reason: "redirect (login)" };
    }
    const body = await response.text();
    const ok = response.ok && body.includes(PANEL.healthMarker);
    return {
      ok,
      statusCode: response.status,
      latencyMs,
      reason: ok ? "ok" : `HTTP ${response.status} / marker ${body.includes(PANEL.healthMarker) ? "found" : "missing"}`,
    };
  } catch (error) {
    const aborted = (error as Error)?.name === "AbortError";
    return {
      ok: false,
      statusCode: null,
      latencyMs: Date.now() - started,
      reason: aborted ? "timeout" : String((error as Error)?.message ?? error).slice(0, 120),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Runs a check and persists the outcome. Returns the result for the caller to render. */
export async function checkAndRecord(env: Env, panel: Panel): Promise<HealthResult> {
  const result = await check(panel);
  await panelsRepo.recordHealth(env, panel.id, {
    status: result.ok ? "ok" : "degraded",
    latencyMs: result.latencyMs,
  });
  if (panel.status === "active" && !result.ok) {
    await panelsRepo.updateStatus(env, panel.id, "degraded", result.reason.slice(0, 200));
  } else if (panel.status === "degraded" && result.ok) {
    await panelsRepo.updateStatus(env, panel.id, "active", null);
  }
  return result;
}
