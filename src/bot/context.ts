/** Per-update execution context shared by all bot handlers. */

import type { Env, PublicConfig } from "../config/env";
import type { TelegramCallbackQuery, TelegramClient, TelegramMessage, TelegramUpdate } from "./telegram";
import type { WebhookIdentity } from "../auth/telegram";
import { BOT_SESSION_TTL_MS } from "../config/constants";
import * as linksRepo from "../database/repositories/links";
import { createLogger, type Logger } from "../utils/logger";
import { AppError, messages } from "../utils/errors";
import { fa } from "./messages";

export type SessionState =
  | "idle"
  | "await_worker_name"
  | "await_admin_search"
  | "await_broadcast_text"
  | "await_plan_limit"
  | "await_plan_price"
  | "await_support_message";

export interface SessionData {
  accountRef?: number;
  panelId?: number;
  planCode?: string;
  userId?: number;
  jobId?: string;
  [key: string]: unknown;
}

export interface BotContext {
  env: Env;
  config: PublicConfig;
  telegram: TelegramClient;
  identity: WebhookIdentity;
  update: TelegramUpdate;
  chatId: number;
  message: TelegramMessage | null;
  callback: TelegramCallbackQuery | null;
  logger: Logger;
  session: { state: SessionState; data: SessionData; messageId: number | null } | null;
  setState(state: SessionState, data?: SessionData): Promise<void>;
  clearState(): Promise<void>;
  reply(text: string, options?: Parameters<TelegramClient["sendMessage"]>[2]): Promise<TelegramMessage | null>;
  edit(text: string, options?: Parameters<TelegramClient["editMessageText"]>[3]): Promise<void>;
  answer(text?: string, alert?: boolean): Promise<void>;
}

export async function createContext(
  env: Env,
  config: PublicConfig,
  telegram: TelegramClient,
  identity: WebhookIdentity,
  update: TelegramUpdate,
): Promise<BotContext> {
  const message = update.message ?? update.edited_message ?? update.callback_query?.message ?? null;
  if (!message) {
    throw new AppError("VALIDATION_FAILED", messages.validation, { detail: "update without a message" });
  }
  const chatId = message.chat.id;
  const sessionRow = await linksRepo.getSession(env, chatId);
  const data: SessionData = sessionRow ? safeParse(sessionRow.payload) : {};

  const logger = createLogger({ traceId: `tg_${identity.updateId ?? "x"}`, scope: "bot" });

  const ctx: BotContext = {
    env,
    config,
    telegram,
    identity,
    update,
    chatId,
    message: update.callback_query ? null : message,
    callback: update.callback_query ?? null,
    logger,
    session: sessionRow
      ? { state: sessionRow.state as SessionState, data, messageId: sessionRow.message_id }
      : null,
    async setState(state, payload = {}) {
      await linksRepo.setSession(env, {
        chatId,
        userId: identity.user.id,
        state,
        payload,
        messageId: ctx.session?.messageId ?? null,
        ttlMs: BOT_SESSION_TTL_MS,
      });
      ctx.session = { state, data: payload, messageId: ctx.session?.messageId ?? null };
    },
    async clearState() {
      await linksRepo.clearSession(env, chatId);
      ctx.session = null;
    },
    async reply(text, options) {
      try {
        return await telegram.sendMessage(chatId, text, options);
      } catch (error) {
        ctx.logger.warn("reply failed", { error });
        return null;
      }
    },
    async edit(text, options) {
      const target = update.callback_query?.message?.message_id;
      if (!target) {
        await ctx.reply(text, options as never);
        return;
      }
      try {
        await telegram.editMessageText(chatId, target, text, options);
      } catch {
        // "message is not modified" and similar: fall back to a new message.
        await ctx.reply(text, options as never);
      }
    },
    async answer(text, alert = false) {
      if (!update.callback_query) return;
      try {
        await telegram.answerCallbackQuery(update.callback_query.id, text, alert);
      } catch {
        /* callback answers are best effort */
      }
    },
  };

  return ctx;
}

function safeParse(raw: string): SessionData {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as SessionData) : {};
  } catch {
    return {};
  }
}

/** Structured, user-safe error rendering. Never leaks internals. */
export function errorText(error: unknown): string {
  if (error instanceof AppError) {
    return `⚠️ ${error.userMessage}`;
  }
  return `⚠️ ${fa.genericError}`;
}
