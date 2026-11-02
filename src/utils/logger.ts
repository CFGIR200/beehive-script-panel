/**
 * Structured logging with mandatory secret redaction.
 *
 * Everything written to the Workers log stream goes through `sanitize()` so a
 * token, bot secret or recovery key can never reach Cloudflare Logs even if a
 * caller passes a whole config object by accident.
 */

const SECRET_KEY_PATTERN = /(token|secret|key|password|credential|authorization|cookie|bearer)/i;

/** Cloudflare API tokens look like 40-char base64url; bot tokens contain a colon. */
const VALUE_PATTERNS: RegExp[] = [
  /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, // telegram bot token
  /\b[A-Za-z0-9_-]{40}\b/g, // cloudflare api token
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
];

export function redactValue(value: string): string {
  let out = value;
  for (const pattern of VALUE_PATTERNS) out = out.replace(pattern, "[redacted]");
  return out;
}

export function sanitize(input: unknown, depth = 0): unknown {
  if (depth > 4) return "[depth]";
  if (input === null || input === undefined) return input;
  if (typeof input === "string") return redactValue(input.length > 500 ? `${input.slice(0, 500)}…` : input);
  if (typeof input === "number" || typeof input === "boolean") return input;
  if (input instanceof Error) return { name: input.name, message: redactValue(input.message) };
  if (Array.isArray(input)) return input.slice(0, 20).map((item) => sanitize(item, depth + 1));
  if (typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      if (SECRET_KEY_PATTERN.test(key)) {
        out[key] = "[redacted]";
        continue;
      }
      out[key] = sanitize(value, depth + 1);
    }
    return out;
  }
  return String(input);
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(options: {
  traceId?: string;
  scope?: string;
  minLevel?: LogLevel;
  sink?: (line: string, level: LogLevel) => void;
} = {}): Logger {
  const min = options.minLevel ?? (globalThis.__BEEHIVE_LOG_LEVEL__ as LogLevel) ?? "info";
  const sink =
    options.sink ??
    ((line: string, level: LogLevel) => {
      if (level === "error") console.error(line);
      else if (level === "warn") console.warn(line);
      else console.log(line);
    });

  const emit = (level: LogLevel, message: string, fields?: Record<string, unknown>) => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[min]) return;
    const record: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      msg: redactValue(message),
    };
    if (options.scope) record.scope = options.scope;
    if (options.traceId) record.trace = options.traceId;
    if (fields) record.fields = sanitize(fields);
    sink(JSON.stringify(record), level);
  };

  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
  };
}

declare global {
  // Test hook: set the minimum log level without touching production code.
  // eslint-disable-next-line no-var
  var __BEEHIVE_LOG_LEVEL__: LogLevel | undefined;
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
