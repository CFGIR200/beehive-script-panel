/**
 * User-facing bot handlers.
 *
 * Every handler is a small function of BotContext. All tenant-scoped reads go
 * through the repositories with the identity's user id, so a callback that
 * points at somebody else's panel simply resolves to "not found".
 */

import type { BotContext } from "./context";
import { errorText } from "./context";
import { fa, changelogBlock } from "./messages";
import {
  accountsKeyboard,
  accountDetailKeyboard,
  backToMainKeyboard,
  backupsKeyboard,
  confirmDeleteKeyboard,
  confirmRestoreKeyboard,
  connectKeyboard,
  mainMenuKeyboard,
  panelActionsKeyboard,
  panelsKeyboard,
  replyMenu,
  statusLabelFa,
  subscriptionKeyboard,
  tokenPermissionHelpKeyboard,
  jobKeyboard,
} from "./keyboards";
import * as accountsRepo from "../database/repositories/accounts";
import * as panelsRepo from "../database/repositories/panels";
import * as jobsRepo from "../database/repositories/jobs";
import * as linksRepo from "../database/repositories/links";
import * as settingsRepo from "../database/repositories/settings";
import * as auditRepo from "../database/repositories/audit";
import * as usersRepo from "../database/repositories/users";
import * as manager from "../panels/manager";
import * as health from "../panels/health";
import { entitlementsFor, describeLimits } from "../subscriptions/limits";
import { cancelJob, startBackup, startDelete, startInstall, startRestore, startUpdate, startUpdateBatch, kickExecutor, type UpdateBatchResult } from "../provisioning/engine";
import { reportJobProgress, jobTitle } from "../provisioning/progress";
import { CONNECT_LINK_TTL_MS, PRODUCT_VERSION } from "../config/constants";
import { sha256Hex, randomToken } from "../utils/ids";
import { formatDateFa, toPersianDigits } from "../utils/time";
import { AppError, messages } from "../utils/errors";
import { humanBytes } from "../panels/artifact";

const TOKEN_PERMISSIONS = ["Workers Scripts:Edit", "D1:Edit", "Account Settings:Read"] as const;

/** Deep link that pre-fills the token form on the Cloudflare dashboard. */
export function tokenCreateUrl(): string {
  const groups = encodeURIComponent(
    JSON.stringify([
      { key: "workers_scripts", type: "edit" },
      { key: "d1", type: "edit" },
      { key: "account_settings", type: "read" },
    ]),
  );
  return `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=${groups}&accountId=*&zoneId=all&name=DevCop`;
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

export async function showMainMenu(ctx: BotContext, edit = true): Promise<void> {
  const text = `${fa.welcome(ctx.identity.user.first_name ?? "دوست عزیز")}\n\n${fa.mainMenu}`;
  if (edit) await ctx.edit(text, { parse_mode: "HTML", reply_markup: mainMenuKeyboard(ctx.identity.isStaff) });
  else await ctx.reply(text, { parse_mode: "HTML", reply_markup: mainMenuKeyboard(ctx.identity.isStaff) });
}

export async function handleStart(ctx: BotContext): Promise<void> {
  await ctx.clearState();
  await ctx.reply(fa.welcome(ctx.identity.user.first_name ?? "دوست عزیز"), {
    parse_mode: "HTML",
    reply_markup: replyMenu(ctx.identity.isStaff),
  });
  await ctx.reply(fa.mainMenu, { parse_mode: "HTML", reply_markup: mainMenuKeyboard(ctx.identity.isStaff) });
}

export async function handleHelp(ctx: BotContext): Promise<void> {
  await ctx.edit(fa.help(ctx.config.supportContact, ctx.config.botUsername), {
    parse_mode: "HTML",
    reply_markup: mainMenuKeyboard(ctx.identity.isStaff),
  });
}

// ---------------------------------------------------------------------------
// Cloudflare connection
// ---------------------------------------------------------------------------

export async function showConnect(ctx: BotContext): Promise<void> {
  if (!ctx.config.botUsername) {
    await ctx.edit("⚙️ نام کاربری ربات در تنظیمات سیستم ثبت نشده است.", { reply_markup: backToMainKeyboard() });
    return;
  }
  await ctx.edit(fa.tokenGuide(tokenCreateUrl()), {
    parse_mode: "HTML",
    reply_markup: connectKeyboard(tokenCreateUrl()),
  });
}

/** Creates the one-time connect link and sends it as a separate message. */
export async function issueConnectLink(ctx: BotContext): Promise<void> {
  const entitlements = await entitlementsFor(ctx.env, ctx.identity.user.id);
  if (entitlements.accountsUsed >= entitlements.maxAccounts) {
    await ctx.answer("به سقف تعداد حساب رسیده‌اید", true);
    await ctx.edit(fa.limitReached(entitlements.maxAccounts, entitlements.accountsUsed), {
      reply_markup: backToMainKeyboard(),
    });
    return;
  }

  const token = randomToken(40);
  const tokenHash = await sha256Hex(token);
  const expiresAt = Date.now() + CONNECT_LINK_TTL_MS;
  await linksRepo.createLink(ctx.env, {
    tokenHash,
    userId: ctx.identity.user.id,
    telegramChatId: ctx.chatId,
    expiresAt,
  });

  const url = `${ctx.config.publicBaseUrl}/connect/${token}`;
  await ctx.reply(fa.connectLink(url, Math.round(CONNECT_LINK_TTL_MS / 60000)), { parse_mode: "HTML" });
  await ctx.answer("لینک اتصال ارسال شد");
  await auditRepo.record(ctx.env, {
    actorType: "telegram_user",
    actorId: ctx.identity.user.id,
    action: "cloudflare.connect_link.issued",
    severity: "info",
  });
}

export async function showAccounts(ctx: BotContext): Promise<void> {
  const accounts = await accountsRepo.listForUser(ctx.env, ctx.identity.user.id);
  const views = await Promise.all(
    accounts.map(async (account) => ({
      id: account.id,
      name: account.account_name,
      panels: (await panelsRepo.listForUser(ctx.env, ctx.identity.user.id)).filter(
        (panel) => panel.account_ref === account.id,
      ).length,
    })),
  );
  await ctx.edit(fa.accounts(views.length), {
    parse_mode: "HTML",
    reply_markup: views.length ? accountsKeyboard(views) : backToMainKeyboard(),
  });
}

export async function showAccountDetail(ctx: BotContext, accountRef: number): Promise<void> {
  const account = await accountsRepo.findForUser(ctx.env, ctx.identity.user.id, accountRef);
  if (!account) {
    await ctx.edit(fa.accountNotFound, { reply_markup: backToMainKeyboard() });
    return;
  }
  const panels = (await panelsRepo.listForUser(ctx.env, ctx.identity.user.id)).filter(
    (panel) => panel.account_ref === account.id,
  );
  await ctx.edit(
    fa.accountDetail({
      name: account.account_name,
      accountId: account.cloudflare_account_id,
      panels: panels.length,
      permissionsOk: account.permissions_verified === 1,
      subdomain: account.workers_subdomain,
    }),
    { parse_mode: "HTML", reply_markup: accountDetailKeyboard(account.id) },
  );
}

export async function disconnectAccountFlow(ctx: BotContext, accountRef: number): Promise<void> {
  const account = await accountsRepo.findForUser(ctx.env, ctx.identity.user.id, accountRef);
  if (!account) {
    await ctx.answer("حساب پیدا نشد", true);
    return;
  }
  const panels = (await panelsRepo.listForUser(ctx.env, ctx.identity.user.id)).filter(
    (panel) => panel.account_ref === account.id && panel.status !== "deleted",
  );
  const warning =
    panels.length > 0
      ? `\n\n⚠️ ${toPersianDigits(panels.length)} پنل روی این حساب ساخته شده است. قطع اتصال، پنل‌ها را حذف نمی‌کند؛ ` +
        `اما تا اتصال مجدد، مدیریت آن‌ها از طریق ربات امکان‌پذیر نیست.`
      : "";
  const { disconnectAccount } = await import("../auth/cloudflare-auth");
  await disconnectAccount(ctx.env, ctx.identity.user.id, account.id);
  await auditRepo.record(ctx.env, {
    actorType: "telegram_user",
    actorId: ctx.identity.user.id,
    action: "cloudflare.disconnected",
    targetType: "cloudflare_account",
    targetId: account.cloudflare_account_id,
    severity: "warning",
  });
  await ctx.edit(`✅ اتصال حساب <b>${escape(account.account_name)}</b> قطع شد و توکن رمزنگاری‌شده حذف گردید.${warning}`, {
    parse_mode: "HTML",
    reply_markup: backToMainKeyboard(),
  });
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

export async function startInstallFlow(ctx: BotContext): Promise<void> {
  const accounts = await accountsRepo.listForUser(ctx.env, ctx.identity.user.id);
  if (accounts.length === 0) {
    await ctx.edit("برای نصب پنل، اول یک حساب Cloudflare متصل کنید. ☁️", {
      reply_markup: connectKeyboard(tokenCreateUrl()),
    });
    return;
  }
  if (accounts.length === 1) {
    await askWorkerName(ctx, accounts[0]!.id);
    return;
  }
  await ctx.edit("کدام حساب Cloudflare برای نصب پنل جدید استفاده شود؟", {
    reply_markup: {
      inline_keyboard: [
        ...accounts.map((account) => [
          { text: `☁️ ${account.account_name.slice(0, 28)}`, callback_data: `panel:new:${account.id}` },
        ]),
        [{ text: "🏠 منوی اصلی", callback_data: "menu:main" }],
      ],
    },
  });
}

export async function askWorkerName(ctx: BotContext, accountRef: number): Promise<void> {
  const account = await accountsRepo.findForUser(ctx.env, ctx.identity.user.id, accountRef);
  if (!account) {
    await ctx.edit(fa.accountNotFound, { reply_markup: backToMainKeyboard() });
    return;
  }
  await ctx.setState("await_worker_name", { accountRef });
  await ctx.edit(
    `🚀 <b>نصب پنل روی ${escape(account.account_name)}</b>\n\n` +
      `یک نام برای Worker بفرستید (حروف کوچک انگلیسی، رقم و خط تیره) ` +
      `یا دکمهٔ «نام خودکار» را بزنید.\n\n` +
      `مثال: <code>honey-8f3k</code>`,
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🎲 نام خودکار", callback_data: `panel:auto:${accountRef}` }],
          [{ text: "✖️ لغو", callback_data: "flow:cancel" }],
        ],
      },
    },
  );
}

export async function handleWorkerNameInput(ctx: BotContext, text: string): Promise<void> {
  const accountRef = Number(ctx.session?.data.accountRef ?? 0);
  if (!accountRef) {
    await ctx.reply(fa.sessionExpired, { reply_markup: mainMenuKeyboard(ctx.identity.isStaff) });
    await ctx.clearState();
    return;
  }
  await ctx.clearState();
  await launchInstall(ctx, accountRef, text.trim().toLowerCase());
}

export async function launchInstall(ctx: BotContext, accountRef: number, workerName: string | null): Promise<void> {
  try {
    const started = await startInstall(ctx.env, ctx.config, {
      userId: ctx.identity.user.id,
      telegramChatId: ctx.chatId,
      accountRef,
      requestedWorkerName: workerName && workerName !== "auto" ? workerName : null,
    });
    const account = await accountsRepo.findForUser(ctx.env, ctx.identity.user.id, accountRef);
    await ctx.edit(fa.installStart(started.workerName ?? "—", account?.account_name ?? "—"), {
      parse_mode: "HTML",
      reply_markup: jobKeyboard(started.job.id),
    });
    await reportJobProgress(ctx.env, ctx.config, started.job.id).catch(() => {});
    kickExecutor(ctx.env, ctx.config);
  } catch (error) {
    ctx.logger.warn("install launch failed", { error });
    await ctx.edit(errorText(error), { reply_markup: mainMenuKeyboard(ctx.identity.isStaff) });
  }
}

export async function showPanels(ctx: BotContext): Promise<void> {
  const views = await manager.listViewsForUser(ctx.env, ctx.identity.user.id);
  if (!views.length) {
    await ctx.edit(fa.panelsEmpty, { reply_markup: mainMenuKeyboard(ctx.identity.isStaff) });
    return;
  }
  const outdated = await panelsRepo.countOutdatedForUser(ctx.env, ctx.identity.user.id, ctx.config.artifactVersion, ctx.config.artifactSha256);
  await ctx.edit(fa.panelsList(views.length), {
    parse_mode: "HTML",
    reply_markup: panelsKeyboard(
      views.map((view) => ({ id: view.id, workerName: view.workerName, status: view.status })),
      { outdated },
    ),
  });
}

/** Shared shape between the user-facing and admin bulk-update summaries. */
export function summarizeUpdateBatch(batch: UpdateBatchResult, to: string): {
  queued: number; busy: number; plan: number; capacity: number; other: number; to: string;
} {
  const by = (reason: string) => batch.skipped.filter((item) => item.reason === reason).length;
  return {
    queued: batch.queued.length,
    busy: by("busy"),
    plan: by("plan"),
    capacity: by("capacity"),
    other: batch.skipped.filter((item) => !"busy|plan|capacity".split("|").includes(item.reason)).length,
    to,
  };
}

/**
 * "Update all opened panels" — confirmation for the user scope. One tap queues
 * an update job for every outdated panel the user owns; each job replaces only
 * the Worker script, so customer data and the baked-in patches always survive.
 */
export async function confirmUpdateAll(ctx: BotContext): Promise<void> {
  const rows = await panelsRepo.listOutdatedForUser(ctx.env, {
    userId: ctx.identity.user.id,
    latestVersion: ctx.config.artifactVersion,
    expectedSha256: ctx.config.artifactSha256,
  });
  if (!rows.length) {
    await ctx.edit(fa.updateAllNone, { reply_markup: backToMainKeyboard() });
    return;
  }
  // UPDRELEASE-1: show the release changelog of the target version in the
  // confirmation. When every outdated panel sits on the same installed version
  // the heading names it explicitly ("نسبت به نسخهٔ …").
  const registered = await panelsRepo.findVersion(ctx.env, ctx.config.artifactVersion);
  const distinctFrom = [...new Set(rows.map((row) => row.version))];
  const changelog = changelogBlock({
    to: ctx.config.artifactVersion,
    from: distinctFrom.length === 1 ? distinctFrom[0] : null,
    changelogFa: registered?.changelog_fa,
  });
  await ctx.edit(fa.updateAllConfirm({ count: rows.length, to: ctx.config.artifactVersion, changelog }), {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: `✅ به‌روزرسانی همه (${rows.length} پنل)`, callback_data: "panel:update_all_go" }],
        [{ text: "🔙 بازگشت", callback_data: "panel:list" }],
      ],
    },
  });
}

export async function launchUpdateAll(ctx: BotContext): Promise<void> {
  const rows = await panelsRepo.listOutdatedForUser(ctx.env, {
    userId: ctx.identity.user.id,
    latestVersion: ctx.config.artifactVersion,
    expectedSha256: ctx.config.artifactSha256,
  });
  if (!rows.length) {
    await ctx.edit(fa.updateAllNone, { reply_markup: backToMainKeyboard() });
    return;
  }
  try {
    const batch = await startUpdateBatch(ctx.env, ctx.config, {
      panelIds: rows.map((row) => row.id),
      actorType: "telegram_user",
      actorId: ctx.identity.user.id,
      telegramChatId: ctx.chatId,
    });
    await ctx.edit(fa.updateAllSummary(summarizeUpdateBatch(batch, ctx.config.artifactVersion)), {
      parse_mode: "HTML",
      reply_markup: backToMainKeyboard(),
    });
    if (batch.queued.length > 0) kickExecutor(ctx.env, ctx.config);
  } catch (error) {
    ctx.logger.warn("update-all launch failed", { error });
    await ctx.edit(errorText(error), { reply_markup: backToMainKeyboard() });
  }
}

export async function showPanelDetail(ctx: BotContext, panelId: number): Promise<void> {
  const view = await manager.viewForUser(ctx.env, ctx.identity.user.id, panelId);
  if (!view) {
    await ctx.edit(fa.panelNotFound, { reply_markup: backToMainKeyboard() });
    return;
  }
  const entitlements = await entitlementsFor(ctx.env, ctx.identity.user.id);
  await ctx.edit(
    fa.panelDetail({
      workerName: view.workerName,
      status: view.statusLabel,
      version: view.version,
      url: view.url ?? "—",
      accountName: view.accountName,
      health: view.health,
      installedAt: view.installedAt,
      updatedAt: view.updatedAt,
    }),
    {
      parse_mode: "HTML",
      reply_markup: panelActionsKeyboard(panelId, {
        canUpdate: entitlements.canUpdate,
        canBackup: entitlements.canBackup,
        url: view.url,
      }),
    },
  );
}

export async function runHealthCheck(ctx: BotContext, panelId: number): Promise<void> {
  const panel = await panelsRepo.findForUser(ctx.env, ctx.identity.user.id, panelId);
  if (!panel) {
    await ctx.answer("پنل پیدا نشد", true);
    return;
  }
  await ctx.answer("در حال بررسی…");
  const result = await health.checkAndRecord(ctx.env, panel);
  const text = result.ok
    ? fa.healthOk(`${toPersianDigits(result.latencyMs)}ms`)
    : fa.healthFail(result.reason);
  await ctx.reply(`${escape(panel.worker_name)}: ${text}`, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [[{ text: "🔙 بازگشت", callback_data: `panel:view:${panelId}` }]] },
  });
}

export async function revealRecoveryKey(ctx: BotContext, panelId: number): Promise<void> {
  const panel = await panelsRepo.findForUser(ctx.env, ctx.identity.user.id, panelId);
  if (!panel) {
    await ctx.answer("پنل پیدا نشد", true);
    return;
  }
  const { recoveryKey } = await manager.revealRecoveryKey(ctx.env, ctx.identity.user.id, panelId);
  await auditRepo.record(ctx.env, {
    actorType: "telegram_user",
    actorId: ctx.identity.user.id,
    action: "panel.recovery_key.revealed",
    targetType: "panel",
    targetId: panel.uid,
    severity: "warning",
  });
  if (!recoveryKey) {
    await ctx.answer("کلید بازیابی برای این پنل ذخیره نشده است", true);
    return;
  }
  // Sent as its own message so the user can delete it independently.
  await ctx.reply(fa.installRecoveryKeyOnly(recoveryKey), { parse_mode: "HTML" });
  await ctx.answer("کلید بازیابی ارسال شد");
}

export async function showUpdateOptions(ctx: BotContext, panelId: number): Promise<void> {
  const panel = await panelsRepo.findForUser(ctx.env, ctx.identity.user.id, panelId);
  if (!panel) {
    await ctx.edit(fa.panelNotFound, { reply_markup: backToMainKeyboard() });
    return;
  }
  // "Current" means the approved build, not just the approved version string:
  // the patched and unpatched 3.1.13 bundles share one version number, so the
  // recorded build digest decides whether the panel really is up to date.
  const registered = await panelsRepo.findVersion(ctx.env, ctx.config.artifactVersion);
  const targetSha = (registered?.artifact_sha256 ?? ctx.config.artifactSha256 ?? "").toLowerCase();
  const versionCurrent = panel.version === ctx.config.artifactVersion;
  const buildCurrent = !targetSha || (panel.artifact_sha256 ?? "").toLowerCase() === targetSha;
  if (versionCurrent && buildCurrent) {
    await ctx.edit(fa.updateNoop(panel.version ?? "—"), {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔁 نصب مجدد همین نسخه", callback_data: `panel:redeploy:${panelId}` }],
          [{ text: "🔙 بازگشت", callback_data: `panel:view:${panelId}` }],
        ],
      },
    });
    return;
  }
  const staleBuildNote = versionCurrent && !buildCurrent
    ? `⚠️ نسخهٔ نصب‌شده درست است اما <b>بیلدِ قدیمی</b> (بدون پچ‌های BEEHIVE) است؛ با به‌روزرسانی، بیلدِ پچ‌شدهٔ همین نسخه جایگزین می‌شود.\n\n`
    : "";
  // UPDRELEASE-1: the confirm screen announces the release changelog of the
  // target version relative to the panel's installed version.
  const changelog = changelogBlock({
    to: ctx.config.artifactVersion,
    from: panel.version,
    changelogFa: registered?.changelog_fa,
  });
  await ctx.edit(
    `🔄 به‌روزرسانی پنل <b>${escape(panel.worker_name)}</b>\n\n` +
      staleBuildNote +
      `نسخهٔ فعلی: <code>${escape(panel.version ?? "—")}</code>\n` +
      `نسخهٔ مقصد: <code>${escape(ctx.config.artifactVersion)}</code>\n\n` +
      `داده‌های پنل روی همان پایگاه D1 می‌مانند و بازنویسی نمی‌شوند.` +
      changelog,
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ به‌روزرسانی کن", callback_data: `panel:update_go:${panelId}` }],
          [{ text: "🔙 بازگشت", callback_data: `panel:view:${panelId}` }],
        ],
      },
    },
  );
}

export async function launchPanelJob(
  ctx: BotContext,
  panelId: number,
  kind: "update" | "redeploy" | "delete" | "backup" | "restore",
  options: { backupId?: number } = {},
): Promise<void> {
  try {
    let jobId = "";
    if (kind === "update" || kind === "redeploy") {
      const started = await startUpdate(ctx.env, ctx.config, {
        userId: ctx.identity.user.id,
        telegramChatId: ctx.chatId,
        panelId,
        redeploy: kind === "redeploy",
      });
      jobId = started.job.id;
    } else if (kind === "delete") {
      const started = await startDelete(ctx.env, ctx.config, {
        userId: ctx.identity.user.id,
        telegramChatId: ctx.chatId,
        panelId,
      });
      jobId = started.job.id;
    } else if (kind === "backup") {
      const started = await startBackup(ctx.env, ctx.config, {
        userId: ctx.identity.user.id,
        telegramChatId: ctx.chatId,
        panelId,
      });
      jobId = started.job.id;
    } else {
      const started = await startRestore(ctx.env, ctx.config, {
        userId: ctx.identity.user.id,
        telegramChatId: ctx.chatId,
        panelId,
        backupId: options.backupId ?? 0,
      });
      jobId = started.job.id;
    }
    await ctx.edit(`⏳ ${jobTitle(kind)} آغاز شد. پیشرفت همین‌جا نمایش داده می‌شود.`, {
      reply_markup: jobKeyboard(jobId),
    });
    await reportJobProgress(ctx.env, ctx.config, jobId).catch(() => {});
    kickExecutor(ctx.env, ctx.config);
  } catch (error) {
    ctx.logger.warn("panel job launch failed", { kind, error });
    await ctx.edit(errorText(error), { reply_markup: backToMainKeyboard() });
  }
}

export async function confirmDelete(ctx: BotContext, panelId: number): Promise<void> {
  const panel = await panelsRepo.findForUser(ctx.env, ctx.identity.user.id, panelId);
  if (!panel) {
    await ctx.edit(fa.panelNotFound, { reply_markup: backToMainKeyboard() });
    return;
  }
  await ctx.edit(fa.deleteWarn({ workerName: panel.worker_name, dbName: panel.d1_database_name }), {
    parse_mode: "HTML",
    reply_markup: confirmDeleteKeyboard(panelId),
  });
}

export async function showBackups(ctx: BotContext, panelId: number): Promise<void> {
  const backups = await panelsRepo.listBackups(ctx.env, panelId, ctx.identity.user.id);
  const completed = backups.filter((backup) => backup.status === "completed");
  if (!completed.length) {
    await ctx.edit(`نسخهٔ پشتیبانی موجود نیست.\n\n${fa.backupStart}`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "💾 پشتیبان‌گیری", callback_data: `panel:backup:${panelId}` }],
          [{ text: "🔙 بازگشت", callback_data: `panel:view:${panelId}` }],
        ],
      },
    });
    return;
  }
  await ctx.edit("♻️ یک نسخهٔ پشتیبان را برای بازیابی انتخاب کنید:", {
    reply_markup: backupsKeyboard(
      panelId,
      completed.map((backup) => ({
        id: backup.id,
        createdAt: formatDateFa(backup.created_at),
        size: humanBytes(backup.size_bytes),
      })),
    ),
  });
}

export async function confirmRestore(ctx: BotContext, panelId: number, backupId: number): Promise<void> {
  const backup = await panelsRepo.findBackup(ctx.env, backupId, ctx.identity.user.id);
  if (!backup || backup.panel_id !== panelId) {
    await ctx.edit(fa.backupEmpty, { reply_markup: backToMainKeyboard() });
    return;
  }
  await ctx.edit(
    `${fa.restoreWarn}\n\n• نسخه: ${escape(formatDateFa(backup.created_at))}\n• حجم: ${escape(humanBytes(backup.size_bytes))}`,
    { parse_mode: "HTML", reply_markup: confirmRestoreKeyboard(panelId, backupId) },
  );
}

// ---------------------------------------------------------------------------
// Misc screens
// ---------------------------------------------------------------------------

export async function showSubscription(ctx: BotContext): Promise<void> {
  const entitlements = await entitlementsFor(ctx.env, ctx.identity.user.id);
  const expires = entitlements.expiresAt ? formatDateFa(entitlements.expiresAt) : "بدون انقضا";
  await ctx.edit(
    fa.subscription({
      planName: entitlements.plan.name,
      status: entitlements.plan.is_active ? "فعال" : "غیرفعال",
      expiresAt: expires,
      limits: describeLimits(entitlements),
    }),
    { parse_mode: "HTML", reply_markup: subscriptionKeyboard() },
  );
}

export async function showStatus(ctx: BotContext): Promise<void> {
  const userId = ctx.identity.user.id;
  const [panels, accounts, activeJobs, summary, installEnabled] = await Promise.all([
    panelsRepo.countForUser(ctx.env, userId),
    accountsRepo.countForUser(ctx.env, userId),
    jobsRepo.activeJobCountForUser(ctx.env, userId),
    manager.healthSummary(ctx.env, userId),
    settingsRepo.getBool(ctx.env, "install_enabled", true),
  ]);
  await ctx.edit(
    fa.status({
      panels,
      accounts,
      activeJobs,
      healthy: summary.healthy,
      degraded: summary.degraded + summary.unknown,
      installEnabled,
    }),
    { parse_mode: "HTML", reply_markup: backToMainKeyboard() },
  );
}

export async function refreshJob(ctx: BotContext, jobId: string): Promise<void> {
  const job = await jobsRepo.findForUser(ctx.env, ctx.identity.user.id, jobId);
  if (!job) {
    await ctx.answer("عملیات پیدا نشد", true);
    return;
  }
  await ctx.answer("به‌روزرسانی شد");
  await reportJobProgress(ctx.env, ctx.config, jobId).catch(() => {});
}

export async function cancelJobFlow(ctx: BotContext, jobId: string): Promise<void> {
  const cancelled = await cancelJob(ctx.env, jobId, ctx.identity.user.id);
  await ctx.answer(cancelled ? fa.cancelled : "امکان لغو نیست");
  if (cancelled) {
    await ctx.edit(fa.jobCancelled, { reply_markup: backToMainKeyboard() });
  }
}

/** Free-text fallback while a session expects input. */
export async function handleSessionInput(ctx: BotContext, text: string): Promise<boolean> {
  const state = ctx.session?.state;
  if (!state || state === "idle") return false;

  if (state === "await_worker_name") {
    await handleWorkerNameInput(ctx, text);
    return true;
  }
  return false;
}

export function escape(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export { TOKEN_PERMISSIONS, PRODUCT_VERSION, statusLabelFa, linksRepo, usersRepo };
