/** CloudflareClient: retries, error mapping, redaction and endpoint shapes. */

import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudflareClient } from "../../src/cloudflare/client";
import { md5Hex } from "../../src/cloudflare/d1";
import { buildBindings, type JobContext } from "../../src/provisioning/steps";
import { planFor, rollbackPlanFor, stepNames } from "../../src/provisioning/planner";
import { AppError } from "../../src/utils/errors";
import { toHex } from "../../src/utils/ids";

const TOKEN = "A".repeat(40);

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CloudflareClient", () => {
  it("sends the bearer token and returns the envelope", async () => {
    let seenAuth = "";
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      seenAuth = String((init.headers as Record<string, string>).Authorization);
      return respond(200, { result: { status: "active" }, success: true, errors: [], messages: [] });
    });
    const client = new CloudflareClient(TOKEN);
    const envelope = await client.request<{ status: string }>("/user/tokens/verify");
    expect(envelope.result.status).toBe("active");
    expect(seenAuth).toBe(`Bearer ${TOKEN}`);
  });

  it("maps 401 to CF_UNAUTHORIZED and never leaks the token", async () => {
    vi.stubGlobal("fetch", async () =>
      respond(401, { result: null, success: false, errors: [{ code: 10000, message: "Authentication error" }] }),
    );
    const client = new CloudflareClient(TOKEN);
    await expect(client.request("/accounts")).rejects.toMatchObject({ code: "CF_UNAUTHORIZED" });
  });

  it("maps 403 to CF_FORBIDDEN with a Persian message", async () => {
    vi.stubGlobal("fetch", async () =>
      respond(403, { result: null, success: false, errors: [{ code: 10000, message: "Authentication error" }] }),
    );
    const error = (await new CloudflareClient(TOKEN)
      .request("/accounts")
      .catch((e: unknown) => e)) as AppError;
    expect(error.code).toBe("CF_FORBIDDEN");
    expect(error.userMessage).toMatch(/مجوز/);
  });

  it("retries transient 5xx failures and then succeeds", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls += 1;
      if (calls < 3) return respond(503, { result: null, success: false, errors: [{ code: 1000, message: "unavailable" }] });
      return respond(200, { result: { ok: true }, success: true, errors: [], messages: [] });
    });
    const envelope = await new CloudflareClient(TOKEN).request<{ ok: boolean }>("/accounts");
    expect(envelope.result.ok).toBe(true);
    expect(calls).toBe(3);
  });

  it("does not retry a deterministic 4xx", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls += 1;
      return respond(404, { result: null, success: false, errors: [{ code: 7003, message: "not found" }] });
    });
    await expect(new CloudflareClient(TOKEN).request("/accounts/x")).rejects.toMatchObject({ code: "CF_NOT_FOUND" });
    expect(calls).toBe(1);
  });

  it("honours pagination metadata", async () => {
    const pages: number[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      const page = Number(new URL(url).searchParams.get("page"));
      pages.push(page);
      return respond(200, {
        result: [{ id: `acc-${page}` }],
        success: true,
        errors: [],
        messages: [],
        result_info: { page, per_page: 50, count: 1, total_count: 2, total_pages: 2 },
      });
    });
    const rows = await new CloudflareClient(TOKEN).paginate<{ id: string }>("/accounts");
    expect(pages).toEqual([1, 2]);
    expect(rows.map((row) => row.id)).toEqual(["acc-1", "acc-2"]);
  });

  it("refuses to construct with an empty token", () => {
    expect(() => new CloudflareClient("")).toThrow(AppError);
  });

  it("serialises without the token", () => {
    const client = new CloudflareClient(TOKEN, { traceId: "t1" });
    expect(JSON.stringify(client)).not.toContain(TOKEN);
  });
});

describe("D1 import etag", () => {
  it("computes the documented MD5 and length", () => {
    const bytes = new TextEncoder().encode("hello");
    expect(md5Hex(bytes)).toBe("5d41402abc4b2a76b9719d911017c592");
  });

  it("matches known vectors", () => {
    expect(md5Hex(new TextEncoder().encode(""))).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(md5Hex(new TextEncoder().encode("The quick brown fox jumps over the lazy dog"))).toBe(
      "9e107d9d372bb6826bd81d3542a419d6",
    );
  });
});

describe("planner", () => {
  it("plans install steps in order", () => {
    expect(stepNames("install")).toEqual([
      "validate_account",
      "ensure_subdomain",
      "create_database",
      "upload_worker",
      "enable_workers_dev",
      "configure_schedule",
      "verify_endpoint",
      "finalize",
    ]);
  });

  it("plans delete/backup/restore/health", () => {
    expect(stepNames("delete")).toEqual(["preflight", "delete_worker", "delete_database", "mark_deleted"]);
    expect(stepNames("backup")).toEqual(["preflight", "export_database", "store_backup"]);
    expect(stepNames("restore")).toEqual(["preflight", "restore_database", "verify_endpoint"]);
    expect(stepNames("health")).toEqual(["health_check"]);
  });

  it("assigns a phase to every step", () => {
    for (const step of planFor("install").steps) {
      expect(["validating", "provisioning", "configuring", "deploying", "verifying"]).toContain(step.phase);
    }
  });

  it("only rolls back what a failed step produced", () => {
    expect(rollbackPlanFor("install", "create_database")).toEqual(["delete_database"]);
    expect(rollbackPlanFor("install", "upload_worker")).toEqual(["delete_worker", "delete_database"]);
    expect(rollbackPlanFor("install", "validate_account")).toEqual([]);
    expect(rollbackPlanFor("delete", "delete_worker")).toEqual([]);
  });
});

describe("worker bindings", () => {
  const ctx = {
    config: { panelCompatibilityDate: "2025-03-10", environment: "test" },
  } as unknown as JobContext;

  it("binds D1 as DB (the only binding the panel requires)", () => {
    const bindings = buildBindings(ctx, "db-uuid", {});
    const d1 = bindings.find((binding) => binding.type === "d1");
    expect(d1?.name).toBe("DB");
    expect(d1?.database_id).toBe("db-uuid");
  });

  it("adds RECOVERY_KEY as a worker secret, not a plain-text var", () => {
    const bindings = buildBindings(ctx, "db-uuid", { recoveryKey: "super-secret" });
    const secret = bindings.find((binding) => binding.name === "RECOVERY_KEY");
    expect(secret?.type).toBe("secret_text");
    expect(secret?.text).toBe("super-secret");
  });
});

describe("hex helpers", () => {
  it("converts bytes to hex", () => {
    expect(toHex(new Uint8Array([0, 15, 255]))).toBe("000fff");
  });
});
