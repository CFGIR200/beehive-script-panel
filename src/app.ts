/**
 * HTTP surface of BEE.HIVE BOT.
 *
 *   POST /telegram/webhook        Telegram updates (secret-token protected)
 *   GET  /connect/:token          one-time Cloudflare connect page
 *   POST /connect/:token          verify API token (step 1)
 *   POST /connect/pick            choose account (step 2)
 *   GET  /dashboard               admin dashboard (session protected)
 *   ...  /dashboard/*             login, verify, logout, actions
 *   GET  /api/dashboard/*         JSON for polling
 *   GET  /health                  public liveness probe
 *   POST /admin/set-webhook       one-time webhook registration (admin secret)
 */

import type { Env, PublicConfig } from "./config/env";
import { readConfig, assertReady, missingSecrets, ConfigError } from "./config/env";
import { handleUpdate } from "./bot/router";
import { authenticate, dedupeUpdate, markUpdateHandled, verifySecret, WebhookAuthError } from "./auth/telegram";
import { handleConnectGet, handleConnectPost, handleConnectPick } from "./web/connect-page";
import {
  handleDashboardAction,
  handleLoginPost,
  handleLogout,
  handleVerifyPost,
  jobsJson,
  loginPage,
  publicHealth,
  renderDashboard,
  summaryJson,
} from "./web/dashboard";
import { json, html, redirect, text, methodNotAllowed } from "./utils/http";
import { AppError, toAppError, messages } from "./utils/errors";
import { createLogger } from "./utils/logger";
import { PRODUCT_NAME, PRODUCT_VERSION } from "./config/constants";
import { consume } from "./security/rate-limit";
import { publicHealthPage } from "./web/status-page";

export interface RequestContext {
  env: Env;
  config: PublicConfig;
  url: URL;
  request: Request;
  ctx: ExecutionContext;
  traceId: string;
}

export async function handleRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const traceId = request.headers.get("CF-Ray") || `req_${Math.random().toString(36).slice(2, 10)}`;
  const logger = createLogger({ traceId, scope: "http" });

  try {
    assertReady(env);
  } catch (error) {
    const message = error instanceof ConfigError ? error.message : "configuration error";
    logger.error("not ready", { message });
    if (url.pathname === "/health") {
      return json({ ok: false, reason: "not_configured", missing: missingSecrets(env) }, 503);
    }
    return html(
      `<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8"><title>${PRODUCT_NAME}</title>
       <body style="font-family:system-ui;direction:rtl;padding:40px;max-width:640px;margin:auto">
       <h1>⚙️ راه‌اندازی ناقص است</h1>
       <p>این استقرار کامل نیست: <code>${escapeHtml(message)}</code></p>
       <p>راهنمای کامل: <code>docs/DEPLOYMENT.md</code></p></body></html>`,
      503,
    );
  }

  let config: PublicConfig;
  try {
    config = readConfig(env);
  } catch (error) {
    logger.error("config error", { error });
    return json({ ok: false, error: "invalid_configuration" }, 500);
  }

  const context: RequestContext = { env, config, url, request, ctx, traceId };

  try {
    // ---- Telegram webhook ------------------------------------------------
    if (url.pathname === "/telegram/webhook") {
      if (request.method !== "POST") return methodNotAllowed(["POST"]);
      return await handleTelegramWebhook(context);
    }

    // ---- connect flow ----------------------------------------------------
    if (url.pathname.startsWith("/connect/")) {
      return await handleConnectRoute(context);
    }

    // ---- dashboard -------------------------------------------------------
    if (url.pathname === "/dashboard" || url.pathname.startsWith("/dashboard/")) {
      return await handleDashboardRoute(context);
    }

    // ---- JSON API --------------------------------------------------------
    if (url.pathname === "/api/dashboard/summary") return await summaryJson(env, request);
    if (url.pathname === "/api/dashboard/jobs") return await jobsJson(env, request);

    // ---- health ----------------------------------------------------------
    if (url.pathname === "/health") {
      return await publicHealth(env);
    }

    if (url.pathname === "/" || url.pathname === "/status") {
      return html(publicHealthPage({ version: PRODUCT_VERSION, botUsername: config.botUsername }));
    }

    // ---- one-time webhook registration -----------------------------------
    if (url.pathname === "/admin/set-webhook") {
      if (request.method !== "POST") return methodNotAllowed(["POST"]);
      return await registerWebhook(context);
    }

    if (url.pathname === "/robots.txt") return text("User-agent: *\nDisallow: /\n");
    if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });

    return json({ ok: false, error: "not_found" }, 404);
  } catch (error) {
    if (error instanceof WebhookAuthError) {
      logger.warn("webhook auth rejected", { reason: error.reason });
      return json({ ok: true }, 200);
    }
    const appError = toAppError(error);
    logger.error("unhandled request error", { code: appError.code, detail: appError.detail });
    if (url.pathname.startsWith("/api/")) {
      return json({ ok: false, error: appError.code, message: appError.userMessage }, appError.httpStatus);
    }
    return html(
      `<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8"><title>خطا</title>
       <body style="font-family:system-ui;direction:rtl;padding:40px;max-width:640px;margin:auto">
       <h1>⚠️ خطایی رخ داد</h1><p>${escapeHtml(appError.userMessage)}</p>
       <p class="small">شناسهٔ رهگیری: <code>${escapeHtml(traceId)}</code></p></body></html>`,
      appError.httpStatus,
    );
  }
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

async function handleTelegramWebhook(context: RequestContext): Promise<Response> {
  const { env, config, request, ctx, traceId } = context;
  const logger = createLogger({ traceId, scope: "webhook" });

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const limit = await consume(env, `webhook:ip:${ip}`, 120, 60 * 1000);
  if (!limit.allowed) {
    logger.warn("webhook rate limited", { ip });
    return json({ ok: true }, 200);
  }

  let update: { update_id?: number };
  try {
    update = (await request.json()) as { update_id?: number };
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }

  verifySecret(request, env.TELEGRAM_WEBHOOK_SECRET, update.update_id ?? null);

  const isNew = await dedupeUpdate(env, update as never);
  if (!isNew) {
    // Telegram retried an update we already handled.
    return json({ ok: true }, 200);
  }

  try {
    const identity = await authenticate(env, request, update as never);
    await handleUpdate(env, config, identity, update as never);
    if (update.update_id) await markUpdateHandled(env, update.update_id);
    // Jobs started by this update run in the background.
    ctx.waitUntil(Promise.resolve());
    return json({ ok: true }, 200);
  } catch (error) {
    if (update.update_id) {
      await markUpdateHandled(env, update.update_id, (error as Error)?.message);
    }
    if (error instanceof WebhookAuthError) throw error;
    const appError = toAppError(error);
    logger.error("update handling failed", { code: appError.code, detail: appError.detail });
    // Always 200: a non-2xx makes Telegram retry the same broken update forever.
    return json({ ok: true }, 200);
  }
}

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------

async function handleConnectRoute(context: RequestContext): Promise<Response> {
  const { env, config, url, request } = context;
  const path = url.pathname;

  if (path === "/connect/pick") {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    return await handleConnectPick(env, config, request);
  }

  const token = decodeURIComponent(path.slice("/connect/".length));
  if (!token || token.includes("/")) return html("Not Found", 404);

  if (request.method === "GET") return await handleConnectGet(env, config, token);
  if (request.method === "POST") return await handleConnectPost(env, config, token, request);
  return methodNotAllowed(["GET", "POST"]);
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

async function handleDashboardRoute(context: RequestContext): Promise<Response> {
  const { env, config, url, request } = context;
  const path = url.pathname;

  if (path === "/dashboard/login") {
    if (request.method === "POST") return await handleLoginPost(env, config, request);
    return html(loginPage());
  }
  if (path === "/dashboard/verify") {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    return await handleVerifyPost(env, request);
  }
  if (path === "/dashboard/logout") {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    return await handleLogout(env, request);
  }
  if (path === "/dashboard/action") {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    return await handleDashboardAction(env, config, request);
  }
  if (path === "/dashboard" || path === "/dashboard/") {
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    return await renderDashboard(env, config, request, url);
  }
  return json({ ok: false, error: "not_found" }, 404);
}

// ---------------------------------------------------------------------------
// One-time webhook registration
// ---------------------------------------------------------------------------

/**
 * POST /admin/set-webhook
 * Requires `Authorization: Bearer <TELEGRAM_WEBHOOK_SECRET>` — an operator
 * action performed once after deployment (scripts/set-webhook.mjs does it).
 */
async function registerWebhook(context: RequestContext): Promise<Response> {
  const { env, config, request } = context;
  const header = request.headers.get("Authorization") || "";
  const provided = header.replace(/^Bearer\s+/i, "").trim();
  if (!provided || provided !== env.TELEGRAM_WEBHOOK_SECRET) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }
  const { TelegramClient } = await import("./bot/telegram");
  const telegram = new TelegramClient(env.TELEGRAM_BOT_TOKEN);
  const webhookUrl = `${config.publicBaseUrl}/telegram/webhook`;
  await telegram.setWebhook(webhookUrl, env.TELEGRAM_WEBHOOK_SECRET, false);
  const info = await telegram.getWebhookInfo();
  return json({ ok: true, url: webhookUrl, info });
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export { AppError, messages, redirect };
