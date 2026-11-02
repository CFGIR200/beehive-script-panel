/** Product-wide constants. Anything configurable at runtime lives in system_settings instead. */

export const PRODUCT_NAME = "BEE.HIVE BOT";
export const PRODUCT_VERSION = "1.0.0";

/** Telegram Bot API base. */
export const TELEGRAM_API_BASE = "https://api.telegram.org";

/** Cloudflare v4 API base. */
export const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

/** Hard limits enforced regardless of plan (plan limits may only be stricter). */
export const HARD_LIMITS = {
  maxPanelsPerUser: 20,
  maxAccountsPerUser: 5,
  maxWorkerNameLength: 54,
  maxConnectLinkAttempts: 5,
  maxBodyBytes: 32 * 1024,
} as const;

export const TIMEOUTS = {
  cloudflareMs: 20000,
  cloudflareUploadMs: 120000,
  verifyMs: 15000,
  telegramMs: 10000,
} as const;

/** Panel-facing constants derived from the audited bundle (docs/INITIAL_AUDIT.md §5). */
export const PANEL = {
  /** The panel reads its D1 binding from exactly this variable name. */
  d1BindingName: "DB",
  /** Optional plain-text vars the panel understands. */
  optionalVars: ["PANEL_TITLE", "PANEL_BRAND", "PANEL_STREAM_PATH", "PANEL_DEBUG", "LOCAL_PREVIEW"] as const,
  /** Optional secrets the panel understands. */
  optionalSecrets: ["RECOVERY_KEY", "PANEL_API_TOKEN"] as const,
  mainModule: "index.mjs",
  /** Marker string asserted when verifying a freshly deployed panel. */
  healthMarker: "Bee.Hive",
} as const;

export const CONNECT_LINK_TTL_MS = 15 * 60 * 1000;
export const BOT_SESSION_TTL_MS = 30 * 60 * 1000;
export const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const WEBHOOK_DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;

export const RATE_LIMITS = {
  /** Telegram updates per user per minute. */
  updatesPerMinute: 40,
  /** Connect-link submissions per IP per 10 minutes. */
  connectPer10Min: 10,
  /** Install attempts per user per hour. */
  installsPerHour: 6,
} as const;

export const JOB_STEP_TIMEOUT_MS = 60 * 1000;
export const JOB_MAX_ATTEMPTS = 3;
export const JOB_LEASE_MS = 2 * 60 * 1000;
