/**
 * Typed access to Worker bindings and environment.
 *
 * Secrets are only referenced through this module so a single grep answers
 * "where is X used?". Nothing here is ever logged or serialised into a
 * Telegram message — see redactValue() in src/utils/logger.ts.
 */

export interface Env {
  // ---- bindings -----------------------------------------------------------
  DB: D1Database;
  CACHE?: KVNamespace;
  ARTIFACTS?: R2Bucket;

  // ---- public configuration ([vars]) -------------------------------------
  ENVIRONMENT?: string;
  PUBLIC_BASE_URL: string;
  BOT_USERNAME: string;
  BOOTSTRAP_ADMIN_TELEGRAM_ID?: string;
  PANEL_ARTIFACT_KEY?: string;
  PANEL_ARTIFACT_VERSION?: string;
  PANEL_ARTIFACT_SHA256?: string;
  PANEL_COMPATIBILITY_DATE?: string;
  PANEL_CRON?: string;
  JOB_SLICE_MS?: string;
  PANEL_VERIFY_ATTEMPTS?: string;
  PANEL_VERIFY_INTERVAL_MS?: string;
  FEATURE_SELF_SERVE_INSTALL?: string;
  FEATURE_PAYMENTS?: string;
  SUPPORT_CONTACT?: string;

  // ---- secrets (wrangler secret put) -------------------------------------
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  /** base64, 32 bytes — AES-256-GCM key for stored Cloudflare tokens. */
  CREDENTIAL_ENCRYPTION_KEY: string;
  /** base64, 32 bytes — previous key, accepted during key rotation. */
  CREDENTIAL_ENCRYPTION_KEY_PREVIOUS?: string;
  /** Random 32+ byte string used to sign dashboard session tokens. */
  SESSION_SIGNING_KEY: string;
}

export interface PublicConfig {
  environment: string;
  publicBaseUrl: string;
  botUsername: string;
  bootstrapAdminId: number | null;
  artifactKey: string;
  artifactVersion: string;
  artifactSha256: string;
  panelCompatibilityDate: string;
  panelCron: string;
  jobSliceMs: number;
  panelVerifyAttempts: number;
  panelVerifyIntervalMs: number;
  selfServeInstall: boolean;
  payments: boolean;
  supportContact: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const REQUIRED_SECRETS = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_WEBHOOK_SECRET",
  "CREDENTIAL_ENCRYPTION_KEY",
  "SESSION_SIGNING_KEY",
] as const;

function intOr(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

/** Reads public configuration; throws ConfigError when a required value is missing. */
export function readConfig(env: Env): PublicConfig {
  const base = (env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
  if (!base) throw new ConfigError("PUBLIC_BASE_URL is not configured");
  let baseUrl: URL;
  try {
    baseUrl = new URL(base);
  } catch {
    throw new ConfigError("PUBLIC_BASE_URL is not a valid URL");
  }
  if (baseUrl.protocol !== "https:" && env.ENVIRONMENT === "production") {
    throw new ConfigError("PUBLIC_BASE_URL must use https in production");
  }

  const bootstrap = Number(env.BOOTSTRAP_ADMIN_TELEGRAM_ID || 0);

  return {
    environment: env.ENVIRONMENT || "development",
    publicBaseUrl: base,
    botUsername: (env.BOT_USERNAME || "").replace(/^@/, ""),
    bootstrapAdminId: Number.isFinite(bootstrap) && bootstrap > 0 ? bootstrap : null,
    artifactKey: env.PANEL_ARTIFACT_KEY || "panel/beehive-panel-3.1.14.js",
    artifactVersion: env.PANEL_ARTIFACT_VERSION || "3.1.14",
    artifactSha256: (env.PANEL_ARTIFACT_SHA256 || "").toLowerCase(),
    panelCompatibilityDate: env.PANEL_COMPATIBILITY_DATE || "2025-03-10",
    panelCron: env.PANEL_CRON || "0 * * * *",
    jobSliceMs: intOr(env.JOB_SLICE_MS, 22000),
    panelVerifyAttempts: intOr(env.PANEL_VERIFY_ATTEMPTS, 5),
    panelVerifyIntervalMs: intOr(env.PANEL_VERIFY_INTERVAL_MS, 2000),
    selfServeInstall: (env.FEATURE_SELF_SERVE_INSTALL ?? "true") !== "false",
    payments: (env.FEATURE_PAYMENTS ?? "false") === "true",
    supportContact: env.SUPPORT_CONTACT || "@BEESELL_GP",
  };
}

/** Verifies every required binding and secret. Called on the first request of a request. */
export function assertReady(env: Env): void {
  if (!env || !env.DB) {
    throw new ConfigError("D1 binding DB is missing");
  }
  if (!env.PUBLIC_BASE_URL) {
    throw new ConfigError("PUBLIC_BASE_URL is missing");
  }
  for (const key of REQUIRED_SECRETS) {
    if (!env[key]) throw new ConfigError(`${key} secret is missing`);
  }
}

/** Names of secrets that are required — used by the /health report. */
export function missingSecrets(env: Env): string[] {
  return REQUIRED_SECRETS.filter((key) => !env[key]);
}
