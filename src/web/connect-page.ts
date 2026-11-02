/**
 * One-time Cloudflare connect page.
 *
 * POST /connect/:token            → step 1: verify the API token, list accounts
 * POST /connect/:token/pick       → step 2: seal the token for the chosen account
 *
 * Security properties:
 *  • the link token is single-use and expires after 15 minutes,
 *  • the API token is submitted with POST only (never in a URL, never in a log),
 *  • the page is excluded from indexing and cannot be framed,
 *  • a wrong/expired link is indistinguishable from a missing one (404).
 */

import type { Env, PublicConfig } from "../config/env";
import { layout, notice } from "./layout";
import * as linksRepo from "../database/repositories/links";
import * as pendingRepo from "../database/repositories/pending";
import * as auditRepo from "../database/repositories/audit";
import { connectAccount } from "../auth/cloudflare-auth";
import { CloudflareClient } from "../cloudflare/client";
import { listAccounts, verifyToken } from "../cloudflare/accounts";
import { credentialContext, seal } from "../security/crypto";
import { requireCloudflareToken } from "../security/validation";
import { escapeHtml, html, redirect, clientIp, type readJson } from "../utils/http";
import { AppError, messages, toAppError } from "../utils/errors";
import { sha256Hex } from "../utils/ids";
import { RATE_LIMITS, CONNECT_LINK_TTL_MS } from "../config/constants";
import { consume } from "../security/rate-limit";
import { TelegramClient } from "../bot/telegram";
import { fa } from "../bot/messages";
import { createLogger } from "../utils/logger";
import { toPersianDigits } from "../utils/time";

const PERMISSION_LIST = [
  "Workers Scripts — Edit",
  "D1 — Edit",
  "Account Settings — Read",
];

export function connectPage(tokenExpiryMinutes: number, error?: string): string {
  const body = `
<div class="card">
  <h1>🔐 اتصال حساب Cloudflare</h1>
  <p>توکن API خود را فقط در همین صفحه وارد کنید. توکن در پیام‌های تلگرام ذخیره نمی‌شود،
     در گزارش‌ها نوشته نمی‌شود و به‌صورت رمزنگاری‌شده (AES-256-GCM) نگه‌داری می‌شود.</p>
  ${error ? notice("error", error) : ""}
  <div class="notice info">
    <b>مجوزهای لازم برای توکن:</b><br>
    ${PERMISSION_LIST.map((permission) => `• ${escapeHtml(permission)}`).join("<br>")}
  </div>
  <form method="POST" autocomplete="off">
    <label for="token">API Token</label>
    <input id="token" name="token" type="password" inputmode="latin" spellcheck="false"
           placeholder="Cloudflare API Token" autocomplete="off" required minlength="40" maxlength="64">
    <button class="btn" type="submit">بررسی و ادامه</button>
  </form>
  <p class="small" style="margin-top:14px">
    ⏱ این صفحه ${toPersianDigits(tokenExpiryMinutes)} دقیقه اعتبار دارد و لینک آن یک‌بارمصرف است.
  </p>
</div>
<div class="card">
  <h2>چطور توکن بسازم؟</h2>
  <p class="small">
    ۱) وارد داشبورد Cloudflare شوید → My Profile → API Tokens → Create Token.<br>
    ۲) از بخش Custom Token دسترسی‌های بالا را اضافه کنید.<br>
    ۳) بعد از ساخت، مقدار توکن را کپی کرده و در کادر بالا بگذارید.
  </p>
</div>`;
  return layout({ title: "اتصال Cloudflare", body });
}

export function accountPickerPage(
  handle: string,
  accounts: Array<{ id: string; name: string }>,
): string {
  const body = `
<div class="card">
  <h1>☁️ انتخاب حساب</h1>
  <p>توکن تأیید شد. حالا حسابی که پنل روی آن نصب می‌شود را انتخاب کنید.</p>
  <form method="POST" action="/connect/pick">
    <input type="hidden" name="handle" value="${escapeHtml(handle)}">
    <label for="account">حساب Cloudflare</label>
    <select id="account" name="account" required>
      ${accounts
        .map(
          (account) =>
            `<option value="${escapeHtml(account.id)}">${escapeHtml(account.name)} — ${escapeHtml(account.id)}</option>`,
        )
        .join("")}
    </select>
    <button class="btn" type="submit">اتصال حساب</button>
  </form>
</div>`;
  return layout({ title: "انتخاب حساب", body });
}

export function resultPage(input: { ok: boolean; title: string; message: string; details?: string[] }): string {
  const body = `
<div class="card">
  <h1>${input.ok ? "✅" : "⚠️"} ${escapeHtml(input.title)}</h1>
  ${notice(input.ok ? "ok" : "error", input.message)}
  ${input.details?.length ? `<div class="list">${input.details.map((line) => `<div class="item">${escapeHtml(line)}</div>`).join("")}</div>` : ""}
  <p class="small">می‌توانید این صفحه را ببندید و به تلگرام بازگردید.</p>
</div>`;
  return layout({ title: input.title, body });
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function findLink(env: Env, token: string): Promise<linksRepo.ConnectLink | null> {
  const tokenHash = await sha256Hex(token);
  const link = await linksRepo.findLink(env, tokenHash);
  if (!link) return null;
  if (link.status !== "pending" || link.expires_at < Date.now()) return null;
  return link;
}

export async function handleConnectGet(
  env: Env,
  config: PublicConfig,
  token: string,
): Promise<Response> {
  void config;
  const link = await findLink(env, token);
  if (!link) {
    return html(connectPage(15, "این لینک معتبر نیست یا منقضی شده است. از ربات لینک تازه بگیرید."), 404);
  }
  return html(connectPage(15));
}

export async function handleConnectPost(
  env: Env,
  config: PublicConfig,
  token: string,
  request: Request,
): Promise<Response> {
  const logger = createLogger({ scope: "connect" });
  const ip = clientIp(request);
  const link = await findLink(env, token);
  if (!link) return html(connectPage(15, "این لینک معتبر نیست یا منقضی شده است."), 404);

  const limit = await consume(env, `connect:ip:${ip}`, RATE_LIMITS.connectPer10Min, 10 * 60 * 1000);
  if (!limit.allowed) {
    return html(connectPage(15, "تعداد تلاش‌ها زیاد است. کمی بعد دوباره تلاش کنید."), 429);
  }

  const form = await request.formData().catch(() => null);
  const rawToken = form ? String(form.get("token") ?? "") : "";
  let apiToken: string;
  try {
    apiToken = requireCloudflareToken(rawToken);
  } catch {
    await linksRepo.registerAttempt(env, link.token_hash);
    return html(connectPage(15, "قالب توکن معتبر نیست؛ مقدار کامل توکن را وارد کنید."), 400);
  }

  const client = new CloudflareClient(apiToken, { traceId: `connect_${link.user_id}` });

  try {
    await verifyToken(client);
    const accounts = await listAccounts(client);
    if (!accounts.length) {
      return html(
        resultPage({
          ok: false,
          title: "حسابی پیدا نشد",
          message: "توکن معتبر است اما به هیچ حسابی دسترسی ندارد. مطمئن شوید توکن برای کل حساب (All accounts) ساخته شده است.",
        }),
        400,
      );
    }

    if (accounts.length === 1) {
      return await completeConnection(env, config, link, apiToken, accounts[0]!.id, ip);
    }

    // Multiple accounts: seal the token and let the user choose.
    const handle = await pendingRepo.create(env, {
      userId: link.user_id,
      telegramChatId: link.telegram_chat_id,
      ciphertext: "",
      iv: "",
      accounts,
      ttlMs: 10 * 60 * 1000,
    });
    const sealed = await seal(apiToken, `pending:${link.user_id}:${handle}`, env.CREDENTIAL_ENCRYPTION_KEY);
    await env.DB.prepare("UPDATE pending_connections SET ciphertext = ?, iv = ? WHERE id = ?")
      .bind(sealed.ciphertext, sealed.iv, handle)
      .run();
    await linksRepo.consumeLink(env, link.token_hash, ip);
    return html(accountPickerPage(handle, accounts));
  } catch (error) {
    const appError = toAppError(error);
    logger.warn("connect verification failed", { code: appError.code, detail: appError.detail });
    await linksRepo.registerAttempt(env, link.token_hash);
    await auditRepo.record(env, {
      actorType: "web",
      actorId: link.user_id,
      action: "cloudflare.connect.failed",
      severity: "warning",
      ip,
      detail: { code: appError.code },
    });
    return html(connectPage(15, appError.userMessage), appError.httpStatus === 500 ? 502 : 400);
  }
}

export async function handleConnectPick(env: Env, config: PublicConfig, request: Request): Promise<Response> {
  const form = await request.formData().catch(() => null);
  const handle = form ? String(form.get("handle") ?? "") : "";
  const accountId = form ? String(form.get("account") ?? "") : "";
  if (!handle || !accountId) return html(resultPage({ ok: false, title: "درخواست نامعتبر", message: "اطلاعات ناقص است." }), 400);

  const pending = await pendingRepo.find(env, handle);
  if (!pending) {
    return html(
      resultPage({ ok: false, title: "زمان تمام شد", message: "این مرحله منقضی شده است. از ربات لینک تازه بگیرید." }),
      410,
    );
  }
  const attempts = await pendingRepo.bumpAttempts(env, handle);
  if (attempts > 5) {
    await pendingRepo.remove(env, handle);
    return html(resultPage({ ok: false, title: "تلاش بیش از حد", message: "لطفاً از ربات لینک تازه بگیرید." }), 429);
  }

  const { unseal } = await import("../security/crypto");
  let apiToken: string;
  try {
    apiToken = await unseal(
      { ciphertext: pending.ciphertext, iv: pending.iv, keyVersion: 1 },
      `pending:${pending.user_id}:${handle}`,
      env.CREDENTIAL_ENCRYPTION_KEY,
    );
  } catch {
    return html(resultPage({ ok: false, title: "خطای داخلی", message: "اطلاعات موقت قابل خواندن نبود؛ لطفاً از ابتدا شروع کنید." }), 500);
  }

  const allowed = pendingRepo.accountsOf(pending).some((account) => account.id === accountId);
  if (!allowed) {
    return html(resultPage({ ok: false, title: "حساب نامعتبر", message: "این حساب در فهرست توکن شما نیست." }), 400);
  }

  await pendingRepo.remove(env, handle);
  const link = {
    token_hash: "",
    user_id: pending.user_id,
    telegram_chat_id: pending.telegram_chat_id,
  } as unknown as linksRepo.ConnectLink;
  return await completeConnection(env, config, link, apiToken, accountId, clientIp(request));
}

async function completeConnection(
  env: Env,
  config: PublicConfig,
  link: { user_id: number; telegram_chat_id: number },
  apiToken: string,
  cloudflareAccountId: string,
  ip: string,
): Promise<Response> {
  const logger = createLogger({ scope: "connect" });
  try {
    const result = await connectAccount(env, config, {
      userId: link.user_id,
      token: apiToken,
      cloudflareAccountId,
      traceId: `connect_${link.user_id}`,
    });

    await auditRepo.record(env, {
      actorType: "web",
      actorId: link.user_id,
      action: "cloudflare.connected",
      targetType: "cloudflare_account",
      targetId: result.accountInfo.id,
      ip,
      detail: { permissionsOk: result.permissions.ok },
    });

    // Notify the user in Telegram (best effort; the page is the source of truth).
    const telegram = new TelegramClient(env.TELEGRAM_BOT_TOKEN);
    const message = result.permissions.ok
      ? fa.connectSuccess(result.accountInfo.name, result.accountInfo.id)
      : fa.connectPermissionsMissing(result.permissions.missing.join("، "));
    await telegram
      .sendMessage(link.telegram_chat_id, message, { parse_mode: "HTML" })
      .catch((error) => logger.warn("telegram notify failed", { error }));

    return html(
      resultPage({
        ok: result.permissions.ok,
        title: result.permissions.ok ? "حساب متصل شد" : "اتصال انجام شد، اما دسترسی‌ها کامل نیست",
        message: result.permissions.ok
          ? `حساب «${result.accountInfo.name}» با موفقیت متصل شد.`
          : messages.permissionMissing,
        details: result.permissions.probes.map(
          (probe) => `${probe.label}: ${probe.granted ? "✅ فعال" : `❌ ${probe.reason}`}`,
        ),
      }),
    );
  } catch (error) {
    const appError = error instanceof AppError ? error : toAppError(error);
    logger.warn("connect completion failed", { code: appError.code });
    await auditRepo.record(env, {
      actorType: "web",
      actorId: link.user_id,
      action: "cloudflare.connect.failed",
      severity: "error",
      ip,
      detail: { code: appError.code },
    });
    return html(resultPage({ ok: false, title: "اتصال ناموفق", message: appError.userMessage }), 400);
  }
}

export { CONNECT_LINK_TTL_MS, redirect, credentialContext };
