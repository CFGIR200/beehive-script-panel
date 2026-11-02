/**
 * Test helpers: database fixtures and a programmable Cloudflare API mock.
 *
 * The mock speaks the same JSON envelope as api.cloudflare.com and asserts the
 * Authorization header on every call, so a test that forgets to send the token
 * fails the same way production would.
 */

import { env } from "cloudflare:test";
import { vi } from "vitest";
import type { Env } from "../src/config/env";
import * as usersRepo from "../src/database/repositories/users";
import * as accountsRepo from "../src/database/repositories/accounts";
import { credentialContext, seal } from "../src/security/crypto";
import { sha256Hex } from "../src/utils/ids";

export const TEST_PANEL_SOURCE = `/* test panel bundle */
export default {
  async fetch(request) {
    return new Response("<!doctype html><html><body>Bee.Hive Panel test bundle</body></html>", {
      headers: { "content-type": "text/html" },
    });
  }
};
`.padEnd(2048, " ");

export const CF_ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
export const TEST_TOKEN = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0";

export async function seedUser(telegramId: number, username = "tester"): Promise<usersRepo.User> {
  const user = await usersRepo.upsertFromTelegram(env as unknown as Env, {
    id: telegramId,
    username,
    first_name: "Test",
    language_code: "fa",
  });
  await usersRepo.grantRole(env as unknown as Env, user.id, "user", null);
  return user;
}

export async function seedAdmin(telegramId: number): Promise<usersRepo.User> {
  const user = await seedUser(telegramId, "admin");
  await usersRepo.grantRole(env as unknown as Env, user.id, "super_admin", null);
  return user;
}

/** Creates a connected Cloudflare account with a sealed credential. */
export async function seedAccount(userId: number, token = TEST_TOKEN): Promise<accountsRepo.CloudflareAccount> {
  const account = await accountsRepo.insertAccount(env as unknown as Env, {
    userId,
    cloudflareAccountId: CF_ACCOUNT_ID,
    accountName: "Test Account",
    tokenVerifiedAt: Date.now(),
    tokenExpiresOn: null,
    tokenIdSuffix: "abc123",
    permissionsVerified: true,
    permissionsDetail: "workers_scripts=ok;d1=ok;account_settings=ok",
  });
  const sealed = await seal(token, credentialContext(userId, account.id, "cloudflare_api_token"), env.CREDENTIAL_ENCRYPTION_KEY);
  await accountsRepo.saveCredential(env as unknown as Env, {
    userId,
    accountRef: account.id,
    purpose: "cloudflare_api_token",
    ciphertext: sealed.ciphertext,
    iv: sealed.iv,
    keyVersion: sealed.keyVersion,
  });
  return account;
}

/**
 * Registers the test bundle in R2 and aligns the panel_versions hash so the
 * installer's integrity check passes. A separate test flips the hash to prove a
 * mismatch is rejected.
 */
export async function registerTestArtifact(version = "3.1.13"): Promise<string> {
  const digest = await sha256Hex(TEST_PANEL_SOURCE);
  await env.DB.prepare("UPDATE panel_versions SET artifact_sha256 = ?, artifact_key = ? WHERE version = ?")
    .bind(digest, `panel/test-${version}.js`, version)
    .run();
  await env.ARTIFACTS!.put(`panel/test-${version}.js`, TEST_PANEL_SOURCE);
  return digest;
}

// ---------------------------------------------------------------------------
// Cloudflare API mock
// ---------------------------------------------------------------------------

export interface MockCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface MockOptions {
  /** Fail a matching call with this status/error instead of succeeding. */
  override?: (call: MockCall) => Response | null;
  /** Simulate missing permissions on the probe endpoints. */
  denyPermissions?: boolean;
  /** Panel HTML returned by the workers.dev URL. */
  panelBody?: string;
  /** Make worker upload fail once. */
  failUploadTimes?: number;
}

export interface MockState {
  calls: MockCall[];
  uploadCount: number;
  deletedWorkers: string[];
  deletedDatabases: string[];
  failUploadTimesRemaining: number;
}

const ok = (result: unknown) =>
  new Response(JSON.stringify({ result, success: true, errors: [], messages: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

function envelopeError(status: number, code: number, message: string): Response {
  return new Response(JSON.stringify({ result: null, success: false, errors: [{ code, message }], messages: [] }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function installCloudflareMock(options: MockOptions = {}): MockState {
  const state: MockState = {
    calls: [],
    uploadCount: 0,
    deletedWorkers: [],
    deletedDatabases: [],
    failUploadTimesRemaining: options.failUploadTimes ?? 0,
  };

  const handler = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const raw = init.headers as Record<string, string>;
      for (const [key, value] of Object.entries(raw)) headers[key.toLowerCase()] = String(value);
    }
    const body = typeof init?.body === "string" ? init.body : undefined;
    const call: MockCall = { method, url, headers, body };
    state.calls.push(call);

    const custom = options.override?.(call);
    if (custom) return custom;

    // ---- panel runtime (workers.dev) -----------------------------------
    if (url.includes(".workers.dev/")) {
      const html = options.panelBody ?? "<!doctype html><html><body>Bee.Hive Panel ready</body></html>";
      return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    }

    // ---- D1 export download / import upload ----------------------------
    if (url.startsWith("https://export.test/")) {
      return new Response("CREATE TABLE users (id INTEGER);\nINSERT INTO users VALUES (1);\n", { status: 200 });
    }
    if (url.startsWith("https://upload.test/")) {
      return new Response("", { status: 200 });
    }

    // ---- everything below is the Cloudflare API ------------------------
    if (!url.startsWith("https://api.cloudflare.com/client/v4/")) {
      return envelopeError(404, 7000, "unexpected url");
    }
    const auth = headers["authorization"] || "";
    if (!auth.startsWith("Bearer ")) return envelopeError(401, 10000, "Authentication error");

    const path = new URL(url).pathname.replace("/client/v4", "");
    const search = new URL(url).search;

    if (path === "/user/tokens/verify") return ok({ id: "tok_1234567890", status: "active" });

    if (path === "/accounts") {
      return new Response(
        JSON.stringify({
          result: [{ id: CF_ACCOUNT_ID, name: "Test Account" }],
          success: true,
          errors: [],
          messages: [],
          result_info: { page: 1, per_page: 50, count: 1, total_count: 1, total_pages: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (path === `/accounts/${CF_ACCOUNT_ID}`) {
      if (options.denyPermissions) return envelopeError(403, 10000, "Authentication error");
      return ok({ id: CF_ACCOUNT_ID, name: "Test Account" });
    }

    if (path === `/accounts/${CF_ACCOUNT_ID}/workers/scripts` && method === "GET") {
      if (options.denyPermissions) return envelopeError(403, 10000, "Authentication error");
      return new Response(
        JSON.stringify({ result: [], success: true, errors: [], messages: [], result_info: { page: 1, total_pages: 1 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (path === `/accounts/${CF_ACCOUNT_ID}/d1/database` && method === "GET") {
      if (options.denyPermissions) return envelopeError(403, 10000, "Authentication error");
      return new Response(
        JSON.stringify({
          result: [{ uuid: "d1-0000-1111-2222-333344445555", name: "existing-db" }],
          success: true,
          errors: [],
          messages: [],
          result_info: { page: 1, total_pages: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (path === `/accounts/${CF_ACCOUNT_ID}/d1/database` && method === "POST") {
      return ok({ uuid: "d1-aaaa-bbbb-cccc-ddddeeeeffff", name: JSON.parse(body ?? "{}").name });
    }

    if (path.startsWith(`/accounts/${CF_ACCOUNT_ID}/d1/database/`) && method === "DELETE") {
      state.deletedDatabases.push(path.split("/").pop() ?? "");
      return ok({});
    }

    if (path.endsWith("/export")) return ok({ signed_url: "https://export.test/dump.sql", at_bookmark: "bm1" });
    if (path.endsWith("/import")) {
      const parsed = JSON.parse(body ?? "{}");
      if (parsed.action === "init") return ok({ upload_url: "https://upload.test/put", filename: "restore.sql" });
      if (parsed.action === "ingest") return ok({});
      return ok({ status: "complete" });
    }

    if (path === `/accounts/${CF_ACCOUNT_ID}/workers/subdomain` && method === "GET") {
      return ok({ subdomain: "testsub" });
    }
    if (path === `/accounts/${CF_ACCOUNT_ID}/workers/subdomain` && method === "PUT") {
      return ok({ subdomain: JSON.parse(body ?? "{}").subdomain });
    }

    const scriptMatch = new RegExp(`^/accounts/${CF_ACCOUNT_ID}/workers/scripts/([a-z0-9-]+)$`).exec(path);
    if (scriptMatch) {
      const name = scriptMatch[1]!;
      if (method === "PUT") {
        if (state.failUploadTimesRemaining > 0) {
          state.failUploadTimesRemaining -= 1;
          return envelopeError(503, 1000, "Service temporarily unavailable");
        }
        state.uploadCount += 1;
        return ok({ id: name, etag: "etag-1", deployment_id: "dep-1" });
      }
      if (method === "DELETE") {
        state.deletedWorkers.push(name);
        return ok({});
      }
    }

    if (path.endsWith("/subdomain") && method === "POST") return ok({ enabled: true, previews_enabled: false });
    if (path.endsWith("/schedules") && method === "PUT") return ok({});
    if (path.endsWith("/schedules") && method === "GET") return ok({ schedules: [{ cron: "0 * * * *" }] });

    void search;
    return envelopeError(404, 7003, `unmocked: ${method} ${path}`);
  };

  vi.stubGlobal("fetch", handler);
  return state;
}

export function restoreFetch(): void {
  vi.unstubAllGlobals();
}

/** Builds a signed Telegram webhook request. */
export function webhookRequest(update: unknown, secret = env.TELEGRAM_WEBHOOK_SECRET): Request {
  return new Request("https://beehive.test/telegram/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": secret,
      "CF-Connecting-IP": "203.0.113.5",
    },
    body: JSON.stringify(update),
  });
}

export function formRequest(
  url: string,
  fields: Record<string, string>,
  options: { redirect?: "manual" | "follow" | "error" } = {},
): Request {
  const body = new URLSearchParams(fields);
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "CF-Connecting-IP": "203.0.113.9" },
    body,
    redirect: options.redirect ?? "follow",
  });
}

export const fakeWorker = {
  async fetch(): Promise<Response> {
    return new Response("ok");
  },
};

export function executionContext(): ExecutionContext {
  const promises: Promise<unknown>[] = [];
  return {
    waitUntil: (promise: Promise<unknown>) => {
      promises.push(promise);
    },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
}
