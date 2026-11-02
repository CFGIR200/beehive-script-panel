/** Typed application errors. Every error carries a stable code so the UI can translate it. */

export type ErrorCode =
  | "VALIDATION_FAILED"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "UNAUTHORIZED"
  | "RATE_LIMITED"
  | "CONFLICT"
  | "LIMIT_REACHED"
  | "CF_UNAUTHORIZED"
  | "CF_FORBIDDEN"
  | "CF_NOT_FOUND"
  | "CF_RATE_LIMITED"
  | "CF_ERROR"
  | "CF_TIMEOUT"
  | "CF_UNAVAILABLE"
  | "PERMISSION_MISSING"
  | "ARTIFACT_MISSING"
  | "ARTIFACT_INTEGRITY"
  | "INTERNAL"
  | "CONFIG";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  /** Safe, human-readable Persian message. Never contains secrets or stack traces. */
  readonly userMessage: string;
  readonly detail?: string;
  readonly retryable: boolean;

  constructor(
    code: ErrorCode,
    userMessage: string,
    options: { httpStatus?: number; detail?: string; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(options.detail ? `${code}: ${options.detail}` : code);
    this.name = "AppError";
    this.code = code;
    this.userMessage = userMessage;
    this.detail = options.detail;
    this.httpStatus = options.httpStatus ?? defaultStatus(code);
    this.retryable = options.retryable ?? defaultRetryable(code);
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

function defaultStatus(code: ErrorCode): number {
  switch (code) {
    case "VALIDATION_FAILED":
      return 400;
    case "UNAUTHORIZED":
    case "CF_UNAUTHORIZED":
      return 401;
    case "FORBIDDEN":
    case "CF_FORBIDDEN":
      return 403;
    case "NOT_FOUND":
    case "CF_NOT_FOUND":
      return 404;
    case "CONFLICT":
      return 409;
    case "LIMIT_REACHED":
      return 422;
    case "RATE_LIMITED":
    case "CF_RATE_LIMITED":
      return 429;
    case "CF_TIMEOUT":
    case "CF_UNAVAILABLE":
      return 503;
    default:
      return 500;
  }
}

function defaultRetryable(code: ErrorCode): boolean {
  return code === "CF_TIMEOUT" || code === "CF_UNAVAILABLE" || code === "CF_RATE_LIMITED" || code === "CF_ERROR";
}

export const messages = {
  validation: "اطلاعات ورودی معتبر نیست. لطفاً دوباره تلاش کنید.",
  notFound: "موردی یافت نشد.",
  forbidden: "شما به این بخش دسترسی ندارید.",
  unauthorized: "نشست شما معتبر نیست؛ دوباره وارد شوید.",
  rateLimited: "تعداد درخواست‌ها زیاد است. کمی بعد دوباره تلاش کنید.",
  conflict: "این عملیات قابل انجام نیست؛ وضعیت فعلی با درخواست شما سازگار نیست.",
  limitReached: "به سقف مجاز پلن خود رسیده‌اید.",
  cfUnauthorized: "توکن Cloudflare نامعتبر یا منقضی شده است.",
  cfForbidden: "توکن Cloudflare مجوز لازم برای این عملیات را ندارد.",
  cfError: "Cloudflare درخواست را نپذیرفت. لطفاً بعداً تلاش کنید.",
  cfTimeout: "ارتباط با Cloudflare زمان‌بر شد. عملیات دوباره تلاش می‌شود.",
  permissionMissing: "مجوزهای توکن Cloudflare کافی نیست.",
  artifactMissing: "نسخهٔ تأییدشدهٔ پنل در دسترس نیست.",
  artifactIntegrity: "بررسی سلامت فایل پنل ناموفق بود؛ نصب متوقف شد.",
  internal: "خطای داخلی رخ داد. شناسهٔ رهگیری برای پشتیبانی ثبت شد.",
  blocked: "دسترسی شما به ربات مسدود شده است.",
  updateNotAllowed: "پلن فعلی شما امکان به‌روزرسانی ندارد.",
  backupNotAllowed: "پلن فعلی شما امکان پشتیبان‌گیری ندارد.",
  backupEmpty: "نسخهٔ پشتیبانی در دسترس نیست.",
} as const;

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/** Converts anything thrown into a safe AppError. */
export function toAppError(error: unknown): AppError {
  if (isAppError(error)) return error;
  if (error instanceof Error) {
    return new AppError("INTERNAL", messages.internal, { detail: error.message.slice(0, 400), cause: error });
  }
  return new AppError("INTERNAL", messages.internal, { detail: String(error).slice(0, 400) });
}
