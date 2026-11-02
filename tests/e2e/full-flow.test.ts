/**
 * End-to-end product flow across the real HTTP surface, the real D1 schema and
 * a mocked Cloudflare API:
 *
 *   dashboard login (Telegram one-time code)
 *     → connect Cloudflare (one-time link)
 *     → install panel
 *     → dashboard reflects it
 *     → delete panel
 */

import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/config/env";
import { readConfig } from "../../src/config/env";
import * as engine from "../../src/provisioning/engine";
import { runJobToCompletion } from "../../src/provisioning/executor";
import * as panelsRepo from "../../src/database/repositories/panels";
import {
  installCloudflareMock,
  registerTestArtifact,
  restoreFetch,
  seedAdmin,
  seedUser,
  TEST_TOKEN,
  formRequest,
} from "../helpers";

const testEnv = env as unknown as Env;
const config = readConfig(testEnv);

beforeEach(() => {
  restoreFetch();
});

describe("web surface", () => {
  it("answers /health and the public status page", async () => {
    const health = await SELF.fetch(new Request("https://beehive.test/health"));
    expect(health.status).toBe(200);
    const body = (await health.json()) as { ok: boolean; version: string };
    expect(body.ok).toBe(true);
    expect(body.version).toBe("1.0.0");

    const page = await SELF.fetch(new Request("https://beehive.test/"));
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("BEE.HIVE BOT");
    expect(html).toContain('dir="rtl"');
  });

  it("protects the dashboard and the JSON API", async () => {
    const dashboard = await SELF.fetch(new Request("https://beehive.test/dashboard", { redirect: "manual" }));
    expect(dashboard.status).toBe(303);
    expect(dashboard.headers.get("Location")).toBe("/dashboard/login");

    const summary = await SELF.fetch(new Request("https://beehive.test/api/dashboard/summary"));
    expect(summary.status).toBe(401);
  });

  it("authenticates a staff user with a Telegram one-time code", async () => {
    const admin = await seedAdmin(8100);
    // Swap the Telegram client for a stub that captures the code.
    const sent: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (String(url).includes("api.telegram.org")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
        sent.push(body.text ?? "");
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: 8100, type: "private" }, date: 0 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return originalFetch(url as never, init as never);
    }) as typeof fetch;

    const loginResponse = await SELF.fetch(formRequest("https://beehive.test/dashboard/login", { telegram_id: "8100" }));
    expect(loginResponse.status).toBe(200);
    const loginBody = await loginResponse.text();
    const handle = /name="handle" value="([a-z0-9]+)"/.exec(loginBody)?.[1];
    expect(handle).toBeTruthy();
    expect(sent.length).toBe(1);

    const code = /<code>(\d{6})<\/code>/.exec(sent[0] ?? "")?.[1];
    expect(code).toBeTruthy();

    // Wrong code is rejected.
    const bad = await SELF.fetch(
      formRequest("https://beehive.test/dashboard/verify", { handle: handle!, code: "000000" }),
    );
    expect(bad.status).toBe(401);

    const good = await SELF.fetch(
      formRequest("https://beehive.test/dashboard/verify", { handle: handle!, code: code! }, { redirect: "manual" }),
    );
    expect(good.status).toBe(303);
    const cookie = good.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain("bh_admin=");
    expect(cookie).toContain("HttpOnly");

    // The session cookie unlocks the dashboard.
    const dashboard = await SELF.fetch(
      new Request("https://beehive.test/dashboard?page=overview", { headers: { Cookie: cookie.split(";")[0]! } }),
    );
    expect(dashboard.status).toBe(200);
    const dashboardHtml = await dashboard.text();
    expect(dashboardHtml).toContain("نمای کلی");
    expect(dashboardHtml).toContain("super_admin");
    expect(dashboardHtml).toContain(String(admin.first_name ?? "Test"));

    // A tampered cookie is rejected.
    const forged = cookie.split(";")[0]!.replace(/[a-z0-9]$/, "x");
    const rejected = await SELF.fetch(
      new Request("https://beehive.test/dashboard", { headers: { Cookie: forged }, redirect: "manual" }),
    );
    expect(rejected.status).toBe(303);

    restoreFetch();
    installCloudflareMock();
  });

  it("does not reveal whether a Telegram id belongs to staff", async () => {
    await seedUser(8200, "normaluser");
    const sent: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (String(url).includes("api.telegram.org")) {
        sent.push(String(init?.body ?? ""));
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: 1, type: "private" }, date: 0 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return originalFetch(url as never, init as never);
    }) as typeof fetch;

    const response = await SELF.fetch(formRequest("https://beehive.test/dashboard/login", { telegram_id: "8200" }));
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("اگر این شناسه متعلق به یک مدیر باشد");
    expect(sent.length).toBe(0); // no code sent to a non-staff user
    restoreFetch();
    installCloudflareMock();
  });
});

describe("complete product flow", () => {
  it("connect → install → dashboard → delete", async () => {
    installCloudflareMock();
    await registerTestArtifact();

    // ---- 1. user connects Cloudflare through the one-time link --------
    const { randomToken, sha256Hex } = await import("../../src/utils/ids");
    const user = await seedUser(8300, "flowuser");
    const token = randomToken(40);
    await testEnv.DB.prepare(
      "INSERT INTO connect_links (token_hash, user_id, telegram_chat_id, status, created_at, expires_at) VALUES (?, ?, ?, 'pending', ?, ?)",
    )
      .bind(await sha256Hex(token), user.id, 8300, Date.now(), Date.now() + 60_000)
      .run();

    const connect = await SELF.fetch(formRequest(`https://beehive.test/connect/${token}`, { token: TEST_TOKEN }));
    expect(connect.status).toBe(200);
    expect(await connect.text()).toContain("حساب متصل شد");

    const account = await testEnv.DB.prepare("SELECT * FROM cloudflare_accounts WHERE user_id = ?")
      .bind(user.id)
      .first<{ id: number; cloudflare_account_id: string }>();
    expect(account).toBeTruthy();

    // ---- 2. install a panel -------------------------------------------
    const started = await engine.startInstall(testEnv, config, {
      userId: user.id,
      telegramChatId: 8300,
      accountRef: account!.id,
    });
    const outcome = await runJobToCompletion(testEnv, config, started.job.id);
    expect(outcome.outcome).toBe("completed");

    const panel = (await panelsRepo.findById(testEnv, started.panel!.id))!;
    expect(panel.status).toBe("active");
    expect(panel.panel_url).toContain(".workers.dev/panel");

    // ---- 3. the dashboard reflects the install ------------------------
    const admin = await seedAdmin(8301);
    const sessionId = "testsession" + "0".repeat(20);
    await testEnv.DB.prepare(
      "INSERT INTO admin_sessions (id, user_id, role, created_at, expires_at, last_seen_at) VALUES (?, ?, 'super_admin', ?, ?, ?)",
    )
      .bind(sessionId, admin.id, Date.now(), Date.now() + 3600_000, Date.now())
      .run();
    const { hmacSha256Hex } = await import("../../src/security/crypto");
    const signature = await hmacSha256Hex(testEnv.SESSION_SIGNING_KEY, `dash:${sessionId}`);
    const cookie = `bh_admin=${sessionId}.${signature}`;

    const dashboard = await SELF.fetch(
      new Request("https://beehive.test/dashboard?page=panels", { headers: { Cookie: cookie } }),
    );
    expect(dashboard.status).toBe(200);
    const dashboardBody = await dashboard.text();
    expect(dashboardBody).toContain(panel.worker_name);

    const summary = await SELF.fetch(
      new Request("https://beehive.test/api/dashboard/summary", { headers: { Cookie: cookie } }),
    );
    const summaryBody = (await summary.json()) as { ok: boolean; panels: number };
    expect(summaryBody.ok).toBe(true);
    expect(summaryBody.panels).toBeGreaterThanOrEqual(1);

    // ---- 4. delete the panel ------------------------------------------
    const deletion = await engine.startDelete(testEnv, config, {
      userId: user.id,
      telegramChatId: 8300,
      panelId: panel.id,
    });
    expect((await runJobToCompletion(testEnv, config, deletion.job.id)).outcome).toBe("completed");
    expect((await panelsRepo.findById(testEnv, panel.id))?.status).toBe("deleted");
  });

  it("rejects dashboard form posts without a valid CSRF token", async () => {
    installCloudflareMock();
    const admin = await seedAdmin(8400);
    const sessionId = "testsession" + "1".repeat(20);
    await testEnv.DB.prepare(
      "INSERT INTO admin_sessions (id, user_id, role, created_at, expires_at, last_seen_at) VALUES (?, ?, 'super_admin', ?, ?, ?)",
    )
      .bind(sessionId, admin.id, Date.now(), Date.now() + 3600_000, Date.now())
      .run();
    const { hmacSha256Hex } = await import("../../src/security/crypto");
    const signature = await hmacSha256Hex(testEnv.SESSION_SIGNING_KEY, `dash:${sessionId}`);

    const before = await testEnv.DB.prepare("SELECT value FROM system_settings WHERE key = 'install_enabled'").first<{
      value: string;
    }>();

    const response = await SELF.fetch(
      new Request("https://beehive.test/dashboard/action", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          Cookie: `bh_admin=${sessionId}.${signature}`,
        },
        body: new URLSearchParams({ action: "set_setting", key: "install_enabled", value: "0", csrf: "wrong" }),
        redirect: "manual",
      }),
    );
    expect(response.status).toBe(303);

    const after = await testEnv.DB.prepare("SELECT value FROM system_settings WHERE key = 'install_enabled'").first<{
      value: string;
    }>();
    expect(after?.value).toBe(before?.value);
  });
});
