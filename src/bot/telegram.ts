/**
 * Minimal, typed Telegram Bot API client.
 *
 * Only the methods this product actually uses are implemented, each verified
 * against core.telegram.org/bots/api. Errors are translated into AppError with
 * the Telegram description attached (never the bot token — it lives in the URL
 * and is stripped before any error leaves this file).
 */

import { TELEGRAM_API_BASE, TIMEOUTS } from "../config/constants";
import { AppError, messages } from "../utils/errors";

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

export interface ReplyKeyboardMarkup {
  keyboard: Array<Array<{ text: string }>>;
  resize_keyboard?: boolean;
  is_persistent?: boolean;
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface TelegramMessage {
  message_id: number;
  date: number;
  chat: { id: number; type: string; username?: string };
  from?: TelegramUser;
  text?: string;
  reply_to_message?: TelegramMessage;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
  edited_message?: TelegramMessage;
}

export interface SendMessageOptions {
  parse_mode?: "HTML" | "MarkdownV2";
  disable_web_page_preview?: boolean;
  reply_markup?: InlineKeyboardMarkup | ReplyKeyboardMarkup;
}

export interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number; migrate_to_chat_id?: number };
}

export class TelegramClient {
  private readonly token: string;
  private readonly traceId?: string;

  constructor(token: string, options: { traceId?: string } = {}) {
    if (!token) throw new AppError("CONFIG", "TELEGRAM_BOT_TOKEN تنظیم نشده است.");
    this.token = token;
    this.traceId = options.traceId;
  }

  /** Token-free representation, safe to log or serialise. */
  toJSON(): Record<string, unknown> {
    return { client: "TelegramClient", traceId: this.traceId };
  }

  private endpoint(method: string): string {
    return `${TELEGRAM_API_BASE}/bot${this.token}/${method}`;
  }

  private sanitize(text: string): string {
    return text.split(this.token).join("[token]").slice(0, 400);
  }

  async call<T>(method: string, payload: Record<string, unknown> = {}, retries = 1): Promise<T> {
    let attempt = 0;
    let lastError: AppError | null = null;

    while (attempt <= retries) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUTS.telegramMs);
      try {
        const response = await fetch(this.endpoint(method), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        const body = (await response.json().catch(() => null)) as TelegramResponse<T> | null;
        if (!body) {
          throw new AppError("INTERNAL", messages.internal, { detail: `telegram ${method}: empty body` });
        }
        if (!body.ok) {
          const description = this.sanitize(body.description ?? "unknown telegram error");
          const retryAfter = body.parameters?.retry_after;
          if (body.error_code === 429 && retryAfter) {
            await new Promise((resolve) => setTimeout(resolve, Math.min(retryAfter, 3) * 1000));
            lastError = new AppError("RATE_LIMITED", messages.rateLimited, { detail: description });
            attempt += 1;
            continue;
          }
          if (body.error_code === 403) {
            throw new AppError("FORBIDDEN", "ربات به این کاربر دسترسی ندارد (کاربر ربات را بلاک کرده است).", {
              detail: description,
            });
          }
          throw new AppError("INTERNAL", "ارتباط با Telegram ناموفق بود.", { detail: `${method}: ${description}` });
        }
        return body.result as T;
      } catch (error) {
        if (error instanceof AppError) {
          if (error.code === "RATE_LIMITED" && attempt < retries) continue;
          throw error;
        }
        const aborted = (error as Error)?.name === "AbortError";
        lastError = new AppError(
          aborted ? "CF_TIMEOUT" : "INTERNAL",
          "ارتباط با Telegram زمان‌بر شد.",
          { detail: aborted ? "timeout" : this.sanitize((error as Error)?.message ?? "network") },
        );
        if (attempt >= retries) throw lastError;
      } finally {
        clearTimeout(timer);
      }
      attempt += 1;
    }
    throw lastError ?? new AppError("INTERNAL", messages.internal);
  }

  sendMessage(chatId: number, text: string, options: SendMessageOptions = {}): Promise<TelegramMessage> {
    return this.call<TelegramMessage>("sendMessage", {
      chat_id: chatId,
      text,
      ...options,
    });
  }

  editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    options: SendMessageOptions = {},
  ): Promise<TelegramMessage | boolean> {
    return this.call<TelegramMessage | boolean>("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      ...options,
    });
  }

  deleteMessage(chatId: number, messageId: number): Promise<boolean> {
    return this.call<boolean>("deleteMessage", { chat_id: chatId, message_id: messageId });
  }

  answerCallbackQuery(id: string, text?: string, showAlert = false): Promise<boolean> {
    return this.call<boolean>("answerCallbackQuery", {
      callback_query_id: id,
      ...(text ? { text: text.slice(0, 190) } : {}),
      show_alert: showAlert,
    });
  }

  getMe(): Promise<TelegramUser> {
    return this.call<TelegramUser>("getMe", {});
  }

  setWebhook(url: string, secretToken: string, dropPending = false): Promise<boolean> {
    return this.call<boolean>("setWebhook", {
      url,
      secret_token: secretToken,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: dropPending,
      max_connections: 40,
    });
  }

  getWebhookInfo(): Promise<Record<string, unknown>> {
    return this.call<Record<string, unknown>>("getWebhookInfo", {});
  }

  deleteWebhook(): Promise<boolean> {
    return this.call<boolean>("deleteWebhook", { drop_pending_updates: false });
  }
}

/** Telegram caps messages at 4096 characters. */
export function splitMessage(text: string, limit = 4000): string[] {
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    const slice = remaining.slice(0, limit);
    const breakAt = Math.max(slice.lastIndexOf("\n\n"), slice.lastIndexOf("\n"), slice.lastIndexOf(" "));
    const cut = breakAt > limit * 0.6 ? breakAt : limit;
    parts.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) parts.push(remaining);
  return parts;
}
