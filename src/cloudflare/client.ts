/**
 * Cloudflare API v4 client.
 *
 * Responsibilities kept here (and nowhere else):
 *  • the Authorization header — the token never leaves this module,
 *  • timeouts via AbortController,
 *  • bounded retry with exponential backoff for transient failures,
 *  • translation of Cloudflare error codes into AppError codes,
 *  • redaction so a token can never appear in a log or an error message.
 *
 * Endpoint inventory (all verified against developers.cloudflare.com/api):
 *   GET    /user/tokens/verify
 *   GET    /accounts
 *   GET    /accounts/{id}/workers/scripts
 *   PUT    /accounts/{id}/workers/scripts/{name}                (multipart upload)
 *   DELETE /accounts/{id}/workers/scripts/{name}
 *   POST   /accounts/{id}/workers/scripts/{name}/subdomain
 *   PUT    /accounts/{id}/workers/scripts/{name}/schedules
 *   GET    /accounts/{id}/workers/subdomain
 *   PUT    /accounts/{id}/workers/subdomain
 *   GET    /accounts/{id}/d1/database
 *   POST   /accounts/{id}/d1/database
 *   GET    /accounts/{id}/d1/database/{uuid}
 *   DELETE /accounts/{id}/d1/database/{uuid}
 *   POST   /accounts/{id}/d1/database/{uuid}/query
 *   POST   /accounts/{id}/d1/database/{uuid}/export
 *   POST   /accounts/{id}/d1/database/{uuid}/import
 */

import { CLOUDFLARE_API_BASE, TIMEOUTS } from "../config/constants";
import { AppError, messages } from "../utils/errors";
import { redactValue } from "../utils/logger";

export interface CloudflareEnvelope<T> {
  result: T;
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  messages: Array<{ code: number; message: string }>;
  result_info?: {
    page: number;
    per_page: number;
    count: number;
    total_count: number;
    total_pages: number;
  };
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  formData?: FormData;
  timeoutMs?: number;
  retries?: number;
  /** Absolute URL override (used for D1 export download URLs). */
  absoluteUrl?: string;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function classify(status: number, code: number | undefined, cfMessage: string): AppError {
  const detail = redactValue(`HTTP ${status}${code ? ` code=${code}` : ""} ${cfMessage}`).slice(0, 300);

  // The HTTP status is the primary signal: Cloudflare reuses code 10000
  // ("Authentication error") for both 401 and 403 responses, so classifying on
  // the code alone would report a missing permission as an invalid token.
  if (status === 401) {
    return new AppError("CF_UNAUTHORIZED", messages.cfUnauthorized, { detail, httpStatus: 401 });
  }
  if (status === 403) {
    return new AppError("CF_FORBIDDEN", messages.cfForbidden, { detail, httpStatus: 403 });
  }
  if (status === 404) return new AppError("CF_NOT_FOUND", "منبع موردنظر در Cloudflare یافت نشد.", { detail });
  if (status === 429) return new AppError("CF_RATE_LIMITED", messages.cfTimeout, { detail });
  if (status >= 500) return new AppError("CF_UNAVAILABLE", messages.cfTimeout, { detail });
  return new AppError("CF_ERROR", messages.cfError, { detail });
}

export class CloudflareClient {
  private readonly token: string;
  private readonly traceId?: string;
  private readonly onRequest?: (info: { method: string; path: string; status: number; ms: number }) => void;

  constructor(token: string, options: { traceId?: string; onRequest?: CloudflareClient["onRequest"] } = {}) {
    if (!token) throw new AppError("CF_UNAUTHORIZED", messages.cfUnauthorized, { detail: "empty token" });
    this.token = token;
    this.traceId = options.traceId;
    this.onRequest = options.onRequest;
  }

  /** Never expose the token — even to a template that stringifies the client. */
  toJSON(): Record<string, unknown> {
    return { client: "CloudflareClient", traceId: this.traceId };
  }

  private async once<T>(path: string, options: RequestOptions): Promise<CloudflareEnvelope<T>> {
    const method = options.method ?? "GET";
    const url = options.absoluteUrl ?? `${CLOUDFLARE_API_BASE}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? TIMEOUTS.cloudflareMs);
    const started = Date.now();

    try {
      const init: RequestInit = {
        method,
        signal: controller.signal,
        headers: { Authorization: `Bearer ${this.token}` },
      };
      if (options.formData) {
        init.body = options.formData;
      } else if (options.body !== undefined) {
        (init.headers as Record<string, string>)["Content-Type"] = "application/json";
        init.body = JSON.stringify(options.body);
      }

      const response = await fetch(url, init);
      const status = response.status;
      let payload: CloudflareEnvelope<T> | null = null;
      const text = await response.text();
      if (text) {
        try {
          payload = JSON.parse(text) as CloudflareEnvelope<T>;
        } catch {
          payload = null;
        }
      }
      this.onRequest?.({ method, path, status, ms: Date.now() - started });

      if (!response.ok || payload?.success === false) {
        const firstError = payload?.errors?.[0];
        throw classify(status, firstError?.code, firstError?.message ?? `${status} ${response.statusText}`);
      }
      if (!payload) {
        throw new AppError("CF_ERROR", messages.cfError, { detail: "empty response body" });
      }
      return payload;
    } catch (error) {
      if (error instanceof AppError) throw error;
      if ((error as Error)?.name === "AbortError") {
        throw new AppError("CF_TIMEOUT", messages.cfTimeout, { detail: `timeout after ${options.timeoutMs ?? TIMEOUTS.cloudflareMs}ms` });
      }
      throw new AppError("CF_UNAVAILABLE", messages.cfTimeout, {
        detail: redactValue((error as Error)?.message ?? "network error"),
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<CloudflareEnvelope<T>> {
    const attempts = Math.max(1, (options.retries ?? 2) + 1);
    let lastError: AppError | null = null;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await this.once<T>(path, options);
      } catch (error) {
        const appError = error instanceof AppError ? error : new AppError("CF_ERROR", messages.cfError);
        lastError = appError;
        const retryable = appError.retryable || appError.code === "CF_UNAVAILABLE";
        if (!retryable || attempt === attempts - 1) throw appError;
        const backoff = 250 * 2 ** attempt + Math.floor(Math.random() * 125);
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }
    throw lastError ?? new AppError("CF_ERROR", messages.cfError);
  }

  /** GET with automatic pagination (capped to keep requests bounded). */
  async paginate<T>(path: string, maxPages = 10): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const separator = path.includes("?") ? "&" : "?";
      const envelope = await this.request<T[]>(`${path}${separator}page=${page}&per_page=50`);
      const result = Array.isArray(envelope.result) ? envelope.result : [];
      out.push(...result);
      const info = envelope.result_info;
      if (!info || page >= (info.total_pages ?? 1) || result.length === 0) break;
    }
    return out;
  }
}

/** Cloudflare error codes worth surfacing to the customer verbatim. */
export const CF_ERROR_HINTS: Record<number, string> = {
  10000: "توکن ارسال‌شده معتبر نیست یا منقضی شده است.",
  10001: "توکن به این عملیات دسترسی ندارد.",
  10002: "درخواست به Cloudflare معتبر نیست.",
  1000: "توکن دسترسی کافی برای این عملیات ندارد.",
  9109: "توکن دسترسی کافی برای این Account ندارد.",
  10034: "محدودیت تعداد درخواست Cloudflare فعال شد؛ کمی بعد تلاش کنید.",
  10400: "نام Worker با قوانین Cloudflare سازگار نیست.",
  7003: "حساب انتخابی پیدا نشد.",
  7500: "پایگاه D1 با این نام ساخته نشد؛ داده‌های ورودی را بررسی کنید.",
};
