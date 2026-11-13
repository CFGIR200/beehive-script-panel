/**
 * Update router: turns a Telegram update into exactly one handler call.
 *
 * Unknown or malformed callback data is answered politely and never reaches a
 * handler, so a forged `callback_data` cannot escalate privileges.
 */

import type { Env, PublicConfig } from "../config/env";
import { TelegramClient, type TelegramUpdate } from "./telegram";
import type { WebhookIdentity } from "../auth/telegram";
import { parseCallback, REPLY_INTENTS } from "./keyboards";
import { createContext, errorText } from "./context";
import { AppError, messages } from "../utils/errors";
import { createLogger } from "../utils/logger";
import * as handlers from "./handlers";
import * as admin from "./admin";
import { fa } from "./messages";

const COMMANDS = new Set(["start", "menu", "help", "cancel", "status", "panels", "new", "subscription", "admin", "id"]);

export async function handleUpdate(
  env: Env,
  config: PublicConfig,
  identity: WebhookIdentity,
  update: TelegramUpdate,
): Promise<void> {
  const telegram = new TelegramClient(env.TELEGRAM_BOT_TOKEN, { traceId: `tg_${update.update_id}` });
  const ctx = await createContext(env, config, telegram, identity, update);
  const logger = createLogger({ scope: "router", traceId: `tg_${update.update_id}` });

  try {
    if (ctx.callback) {
      await handleCallback(ctx);
      return;
    }

    const text = (ctx.message?.text ?? "").trim();
    if (!text) {
      await ctx.reply("در حال حاضر فقط پیام متنی پشتیبانی می‌شود.");
      return;
    }

    // Reply-keyboard intents (persistent bottom menu)
    const replyIntent = REPLY_INTENTS[text];
    if (replyIntent) {
      await handleIntent(ctx, replyIntent);
      return;
    }

    if (text.startsWith("/")) {
      const [rawCommand, ...rest] = text.slice(1).split(/\s+/);
      const command = (rawCommand ?? "").split("@")[0]!.toLowerCase();
      if (!COMMANDS.has(command)) {
        await ctx.reply(fa.unknownCommand, {});
        return;
      }
      await handleCommand(ctx, command, rest.join(" "));
      return;
    }

    // Free text: session input first, then admin flows.
    if (await handlers.handleSessionInput(ctx, text)) return;
    if (await admin.handlePlanInput(ctx, text)) return;
    if (ctx.session?.state === "await_admin_search") {
      await admin.handleAdminSearch(ctx, text);
      return;
    }
    if (ctx.session?.state === "await_broadcast_text") {
      await admin.handleBroadcastText(ctx, text);
      return;
    }

    await ctx.reply(fa.unknownCommand, {});
  } catch (error) {
    logger.error("handler failed", { error });
    const text = errorText(error);
    try {
      if (ctx.callback) await ctx.answer(text.replace(/^⚠️\s*/, ""), true);
      else await ctx.reply(text, {});
    } catch {
      /* nothing else to do */
    }
  }
}

async function handleCommand(
  ctx: Awaited<ReturnType<typeof createContext>>,
  command: string,
  args: string,
): Promise<void> {
  switch (command) {
    case "start":
      await handlers.handleStart(ctx);
      return;
    case "menu":
      await handlers.showMainMenu(ctx, false);
      return;
    case "help":
      await handlers.handleHelp(ctx);
      return;
    case "cancel":
      await ctx.clearState();
      await ctx.reply(fa.cancelled, {});
      await handlers.showMainMenu(ctx, false);
      return;
    case "status":
      await ctx.reply("📊", {});
      await handlers.showStatus(ctx);
      return;
    case "panels":
      await handlers.showPanels(ctx);
      return;
    case "new":
      await handlers.startInstallFlow(ctx);
      return;
    case "subscription":
      await handlers.showSubscription(ctx);
      return;
    case "admin":
      if (!ctx.identity.isAdmin) {
        await ctx.reply(fa.adminOnly, {});
        return;
      }
      await admin.adminHome(ctx);
      return;
    case "id":
      await ctx.reply(
        `شناسهٔ تلگرام شما: <code>${ctx.identity.user.telegram_id}</code>\nشناسهٔ داخلی: <code>${ctx.identity.user.id}</code>`,
        { parse_mode: "HTML" },
      );
      return;
    default:
      void args;
      await ctx.reply(fa.unknownCommand, {});
  }
}

async function handleIntent(ctx: Awaited<ReturnType<typeof createContext>>, intent: string): Promise<void> {
  switch (intent) {
    case "install":
      await handlers.startInstallFlow(ctx);
      return;
    case "panels":
      await handlers.showPanels(ctx);
      return;
    case "connect":
      await handlers.showConnect(ctx);
      return;
    case "status":
      await handlers.showStatus(ctx);
      return;
    case "subscription":
      await handlers.showSubscription(ctx);
      return;
    case "help":
      await handlers.handleHelp(ctx);
      return;
    case "admin":
      if (!ctx.identity.isAdmin) {
        await ctx.reply(fa.adminOnly, {});
        return;
      }
      await admin.adminHome(ctx);
      return;
    default:
      await ctx.reply(fa.unknownCommand, {});
  }
}

async function handleCallback(ctx: Awaited<ReturnType<typeof createContext>>): Promise<void> {
  const parsed = parseCallback(ctx.callback?.data);
  if (!parsed) {
    await ctx.answer("دکمهٔ نامعتبر", true);
    return;
  }
  const { namespace, action, args } = parsed;
  const numeric = (index: number): number => {
    const value = Number(args[index]);
    if (!Number.isFinite(value) || value <= 0) throw new AppError("VALIDATION_FAILED", messages.validation);
    return Math.trunc(value);
  };

  switch (`${namespace}:${action}`) {
    // ---- menus ---------------------------------------------------------
    case "menu:main":
      await ctx.clearState();
      await handlers.showMainMenu(ctx);
      return;
    case "help:view":
      await handlers.handleHelp(ctx);
      return;
    case "status:view":
      await handlers.showStatus(ctx);
      return;
    case "sub:view":
      await handlers.showSubscription(ctx);
      return;
    case "flow:cancel":
      await ctx.clearState();
      await ctx.answer(fa.cancelled);
      await handlers.showMainMenu(ctx);
      return;

    // ---- cloudflare ----------------------------------------------------
    case "cf:list":
      await handlers.showAccounts(ctx);
      return;
    case "cf:link":
      await handlers.issueConnectLink(ctx);
      return;
    case "cf:pick":
      await handlers.showAccountDetail(ctx, numeric(0));
      return;
    case "cf:disconnect":
      await handlers.disconnectAccountFlow(ctx, numeric(0));
      return;
    case "cf:token_help":
      await handlers.showConnect(ctx);
      return;

    // ---- panels --------------------------------------------------------
    case "panel:list":
      await handlers.showPanels(ctx);
      return;
    case "panel:new":
      // `panel:new` (no args) → account picker; `panel:new:<accountRef>` → name prompt.
      if (args.length === 1) await handlers.askWorkerName(ctx, numeric(0));
      else await handlers.startInstallFlow(ctx);
      return;
    case "panel:view":
      await handlers.showPanelDetail(ctx, numeric(0));
      return;
    case "panel:health":
      await handlers.runHealthCheck(ctx, numeric(0));
      return;
    case "panel:reveal":
      await handlers.revealRecoveryKey(ctx, numeric(0));
      return;
    case "panel:update":
      await handlers.showUpdateOptions(ctx, numeric(0));
      return;
    case "panel:update_go":
      await handlers.launchPanelJob(ctx, numeric(0), "update");
      return;
    case "panel:update_all":
      await handlers.confirmUpdateAll(ctx);
      return;
    case "panel:update_all_go":
      await handlers.launchUpdateAll(ctx);
      return;
    case "panel:redeploy":
      await handlers.launchPanelJob(ctx, numeric(0), "redeploy");
      return;
    case "panel:delete":
      await handlers.confirmDelete(ctx, numeric(0));
      return;
    case "panel:delete_yes":
      await handlers.launchPanelJob(ctx, numeric(0), "delete");
      return;
    case "panel:backup":
      await handlers.launchPanelJob(ctx, numeric(0), "backup");
      return;
    case "panel:restores":
      await handlers.showBackups(ctx, numeric(0));
      return;
    case "panel:restore":
      await handlers.confirmRestore(ctx, numeric(0), numeric(1));
      return;
    case "panel:restore_yes":
      await handlers.launchPanelJob(ctx, numeric(0), "restore", { backupId: numeric(1) });
      return;

    // ---- install wizard ------------------------------------------------
    case "panel:auto":
      await handlers.launchInstall(ctx, numeric(0), null);
      return;

    // ---- jobs ----------------------------------------------------------
    case "job:refresh":
      await handlers.refreshJob(ctx, args[0] ?? "");
      return;
    case "job:cancel":
      await handlers.cancelJobFlow(ctx, args[0] ?? "");
      return;

    // ---- admin ---------------------------------------------------------
    default:
      if (namespace === "adm") {
        await handleAdminCallback(ctx, action, args, numeric);
        return;
      }
      await ctx.answer("این گزینه در دسترس نیست", true);
  }
}

async function handleAdminCallback(
  ctx: Awaited<ReturnType<typeof createContext>>,
  action: string,
  args: string[],
  numeric: (index: number) => number,
): Promise<void> {
  if (!ctx.identity.isAdmin) {
    await ctx.answer(fa.adminOnly, true);
    return;
  }
  switch (action) {
    case "home":
      await admin.adminHome(ctx);
      return;
    case "users":
      await admin.adminUsers(ctx, args.length ? numeric(0) : 1);
      return;
    case "search":
      await admin.adminSearchPrompt(ctx);
      return;
    case "user":
      await admin.adminUser(ctx, numeric(0));
      return;
    case "block":
      await admin.adminBlock(ctx, numeric(0), true);
      return;
    case "unblock":
      await admin.adminBlock(ctx, numeric(0), false);
      return;
    case "plan_pick":
      await admin.adminPlanPicker(ctx, numeric(0));
      return;
    case "plan_grant":
      await admin.adminGrantPlan(ctx, numeric(0), args[1] ?? "");
      return;
    case "plans":
      await admin.adminPlans(ctx);
      return;
    case "plan_edit":
      await admin.adminPlanDetail(ctx, args[0] ?? "");
      return;
    case "plan_limit":
      await admin.adminPlanLimitPrompt(ctx, args[0] ?? "");
      return;
    case "plan_price":
      await admin.adminPlanPricePrompt(ctx, args[0] ?? "");
      return;
    case "jobs":
      await admin.adminJobs(ctx, args.length ? numeric(0) : 1);
      return;
    case "settings":
      await admin.adminSettings(ctx);
      return;
    case "toggle_install":
      await admin.adminToggleSetting(ctx, "install_enabled");
      return;
    case "toggle_maintenance":
      await admin.adminToggleSetting(ctx, "maintenance_mode");
      return;
    case "toggle_update_notify":
      await admin.adminToggleSetting(ctx, "update_notify_enabled");
      return;
    case "toggle_update_auto":
      await admin.adminToggleSetting(ctx, "update_auto_apply");
      return;
    case "update_all":
      await admin.adminUpdateAllPrompt(ctx);
      return;
    case "update_all_go":
      await admin.adminUpdateAllRun(ctx);
      return;
    case "infra":
      await admin.adminInfra(ctx);
      return;
    case "broadcast":
      await admin.adminBroadcastPrompt(ctx);
      return;
    case "broadcast_yes":
      await admin.confirmBroadcast(ctx);
      return;
    default:
      await ctx.answer("این گزینه در دسترس نیست", true);
  }
}
