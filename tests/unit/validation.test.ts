import { describe, expect, it } from "vitest";
import {
  requireBoolean,
  requireCloudflareAccountId,
  requireCloudflareToken,
  requireEnum,
  requireInteger,
  requirePositiveIntFa,
  requireString,
  requireUuid,
  requireWorkerName,
  sanitizeSearchTerm,
  toEnglishDigits,
} from "../../src/security/validation";
import { AppError } from "../../src/utils/errors";
import { parseCallback, cb, statusEmoji, REPLY_INTENTS } from "../../src/bot/keyboards";
import { redactValue, sanitize } from "../../src/utils/logger";
import { splitMessage } from "../../src/bot/telegram";

const expectValidationError = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("VALIDATION_FAILED");
    return;
  }
  throw new Error("expected a validation error");
};

describe("input validation", () => {
  it("accepts a well-formed Cloudflare token and rejects junk", () => {
    const token = "A".repeat(40);
    expect(requireCloudflareToken(token)).toBe(token);
    expectValidationError(() => requireCloudflareToken("short"));
    expectValidationError(() => requireCloudflareToken("A".repeat(40) + ":bot"));
    expectValidationError(() => requireCloudflareToken(`${"A".repeat(20)} ${"B".repeat(20)} `));
  });

  it("enforces Cloudflare account id shape", () => {
    expect(requireCloudflareAccountId("0123456789abcdef0123456789abcdef")).toBe("0123456789abcdef0123456789abcdef");
    expectValidationError(() => requireCloudflareAccountId("xyz"));
    expectValidationError(() => requireCloudflareAccountId("../etc/passwd"));
  });

  it("enforces worker-name rules", () => {
    expect(requireWorkerName("honey-8f3k")).toBe("honey-8f3k");
    expectValidationError(() => requireWorkerName("-leading"));
    expectValidationError(() => requireWorkerName("trailing-"));
    expectValidationError(() => requireWorkerName("UPPER-case"));
    expectValidationError(() => requireWorkerName("double--dash"));
    expectValidationError(() => requireWorkerName("a"));
  });

  it("rejects traversal-looking identifiers", () => {
    expectValidationError(() => requireUuid("../../etc/passwd"));
    expect(requireUuid("0b8f9d8e-1111-2222-3333-444455556666")).toBe("0b8f9d8e-1111-2222-3333-444455556666");
  });

  it("normalises Persian digits in operator input", () => {
    expect(toEnglishDigits("۱۲۳۴۵۶۷۸۹۰")).toBe("1234567890");
    expect(requirePositiveIntFa("۴۲", "max_panels")).toBe(42);
    expectPositiveZero();
  });

  it("caps and strips control characters from search terms", () => {
    expect(sanitizeSearchTerm("  @user\u0000name  ")).toBe("@username");
    expect(sanitizeSearchTerm("x".repeat(200)).length).toBe(64);
  });

  it("validates enums, integers and booleans", () => {
    expect(requireEnum("admin", "role", ["admin", "user"] as const)).toBe("admin");
    expectValidationError(() => requireEnum("root", "role", ["admin", "user"] as const));
    expect(requireInteger("12", "n", { min: 0, max: 20 })).toBe(12);
    expectValidationError(() => requireInteger(21, "n", { min: 0, max: 20 }));
    expect(requireBoolean("true", "flag")).toBe(true);
    expectValidationError(() => requireBoolean("maybe", "flag"));
    expect(requireString("  hi  ", "s")).toBe("hi");
  });
});

function expectPositiveZero() {
  expect(requirePositiveIntFa("0", "n", { allowZero: true })).toBe(0);
  expectValidationError(() => requirePositiveIntFa("0", "n"));
}

describe("callback data", () => {
  it("parses namespaced payloads", () => {
    const parsed = parseCallback(cb("panel", "view", 12));
    expect(parsed).toEqual({ namespace: "panel", action: "view", args: ["12"] });
  });

  it("rejects malformed or oversized payloads", () => {
    expect(parseCallback("nonsense")).toBeNull();
    expect(parseCallback(undefined)).toBeNull();
    expect(parseCallback("a".repeat(200))).toBeNull();
    expect(parseCallback("BAD:Action")).toBeNull();
    expect(() => cb("panel", "view", "x".repeat(80))).toThrow();
  });

  it("maps reply keyboard labels to intents", () => {
    expect(REPLY_INTENTS["📦 پنل‌های من"]).toBe("panels");
    expect(Object.keys(REPLY_INTENTS).length).toBeGreaterThanOrEqual(7);
  });

  it("maps panel status to an emoji", () => {
    expect(statusEmoji("active")).toBe("🟢");
    expect(statusEmoji("failed")).toBe("🔴");
    expect(statusEmoji("unknown-status")).toBe("⚪️");
  });
});

describe("redaction", () => {
  it("strips tokens from strings", () => {
    const botToken = "123456789:AAFakeTokenValueThatIsLongEnoughHere";
    expect(redactValue(`token=${botToken}`)).not.toContain("AAFakeTokenValue");
    expect(redactValue("Bearer abcdefghijklmnopqrstuvwxyz0123456789")).toContain("[redacted]");
  });

  it("redacts sensitive object keys recursively", () => {
    const sanitized = sanitize({
      api_token: "abc",
      nested: { TELEGRAM_BOT_TOKEN: "123:xyz", safe: "value" },
      list: [{ secret: "hidden" }],
    }) as Record<string, any>;
    expect(sanitized.api_token).toBe("[redacted]");
    expect(sanitized.nested.TELEGRAM_BOT_TOKEN).toBe("[redacted]");
    expect(sanitized.nested.safe).toBe("value");
    expect(sanitized.list[0].secret).toBe("[redacted]");
  });
});

describe("message splitting", () => {
  it("splits long text under the Telegram limit", () => {
    const parts = splitMessage("a".repeat(9000));
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(4000);
  });

  it("keeps short text intact", () => {
    expect(splitMessage("hello")).toEqual(["hello"]);
  });
});
