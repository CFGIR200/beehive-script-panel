/**
 * Telegram webhook authentication, replay protection and rate limiting.
 */

import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/config/env";
import { formRequest, installCloudflareMock, restoreFetch, webhookRequest } from "../helpers";

const testEnv = env as unknown as Env;

const startUpdate = (updateId: number, telegramId: number) => ({
  update_id: updateId,
  message: {
    message_id: updateId,
    date: Math.floor(Date.now() / 1000),
    chat: { id: telegramId, type: "private" },
    from: { id: telegramId, is_bot: false, first_name: "Tester", username: `u${telegramId}` },
    text: "/start",
  },
});

async function seedUpdateRow(updateId: number): Promise<void> {
  await testEnv.DB.prepare(
    "INSERT INTO webhook_events (source, update_id, dedupe_key, received_at) VALUES ('telegram', ?, ?, ?)",
  )
    .bind(updateId, `tg:${updateId}`, Date.now())
    .run();
}

beforeEach(async () => {
  restoreFetch();
  installCloudflareMock();
});

describe("webhook authentication", () => {
  it("rejects a request without the secret header", async () => {
    const response = await SELF.fetch(
      new Request("https://beehive.test/telegram/webhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(startUpdate(1, 5001)),
      }),
    );
    // A forged update is answered with 200 (so Telegram stops retrying) but the
    // update must not be processed.
    expect([200, 401]).toContain(response.status);
    const row = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM webhook_events WHERE update_id = 1").first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it("rejects a request with the wrong secret", async () => {
    const response = await SELF.fetch(webhookRequest(startUpdate(2, 5002), "wrong-secret-value-xxxxxxxxxxxxx"));
    expect([200, 401]).toContain(response.status);
    const row = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM webhook_events WHERE update_id = 2").first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it("accepts a correctly signed update", async () => {
    const response = await SELF.fetch(webhookRequest(startUpdate(3, 5003)));
    expect(response.status).toBe(200);
    const row = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM webhook_events WHERE update_id = 3").first<{ n: number }>();
    expect(row?.n).toBe(1);
    const user = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE telegram_id = 5003").first<{ n: number }>();
    expect(user?.n).toBe(1);
  });

  it("does not process the same update twice (replay)", async () => {
    const first = await SELF.fetch(webhookRequest(startUpdate(4, 5004)));
    expect(first.status).toBe(200);
    const usersBefore = await testEnv.DB.prepare("SELECT last_seen_at FROM users WHERE telegram_id = 5004").first<{ last_seen_at: number }>();

    const second = await SELF.fetch(webhookRequest(startUpdate(4, 5004)));
    expect(second.status).toBe(200);

    const usersAfter = await testEnv.DB.prepare("SELECT last_seen_at FROM users WHERE telegram_id = 5004").first<{ last_seen_at: number }>();
    // The duplicate was dropped before the handler ran.
    expect(usersAfter?.last_seen_at).toBe(usersBefore?.last_seen_at);
  });

  it("rejects non-POST methods", async () => {
    const response = await SELF.fetch(new Request("https://beehive.test/telegram/webhook"));
    expect(response.status).toBe(405);
  });

  it("rejects invalid JSON bodies", async () => {
    const response = await SELF.fetch(
      new Request("https://beehive.test/telegram/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Telegram-Bot-Api-Secret-Token": testEnv.TELEGRAM_WEBHOOK_SECRET,
        },
        body: "{not json",
      }),
    );
    expect(response.status).toBe(400);
  });
});

describe("abuse controls", () => {
  it("stops processing after the per-user rate limit", async () => {
    // Burn the bucket.
    const now = Date.now();
    const windowStart = Math.floor(now / 60000) * 60000;
    await testEnv.DB.prepare("INSERT INTO rate_limits (bucket_key, window_start, count) VALUES (?, ?, ?)")
      .bind("tg:u:5100", windowStart, 40)
      .run();

    const response = await SELF.fetch(webhookRequest(startUpdate(10, 5100)));
    expect(response.status).toBe(200);
    const user = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE telegram_id = 5100").first<{ n: number }>();
    expect(user?.n).toBe(0);
  });

  it("never processes updates from a blocked user", async () => {
    await testEnv.DB.prepare(
      "INSERT INTO users (telegram_id, first_name, created_at, last_seen_at, is_blocked) VALUES (?, ?, ?, ?, 1)",
    )
      .bind(5200, "Blocked", Date.now(), Date.now())
      .run();
    await SELF.fetch(webhookRequest(startUpdate(11, 5200)));
    const sessions = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM bot_sessions WHERE chat_id = ?")
      .bind(5200)
      .first<{ n: number }>();
    expect(sessions?.n).toBe(0);
  });
});

describe("connect page", () => {
  it("returns 404 for an unknown link", async () => {
    const response = await SELF.fetch(new Request("https://beehive.test/connect/not-a-real-token"));
    expect(response.status).toBe(404);
  });

  it("serves the form for a valid link and is not indexable", async () => {
    const { randomToken, sha256Hex } = await import("../../src/utils/ids");
    const token = randomToken(40);
    const user = await testEnv.DB.prepare(
      "INSERT INTO users (telegram_id, first_name, created_at, last_seen_at) VALUES (?, 'X', ?, ?) RETURNING id",
    )
      .bind(5300, Date.now(), Date.now())
      .first<{ id: number }>();
    await testEnv.DB.prepare(
      "INSERT INTO connect_links (token_hash, user_id, telegram_chat_id, status, created_at, expires_at) VALUES (?, ?, ?, 'pending', ?, ?)",
    )
      .bind(await sha256Hex(token), user!.id, 5300, Date.now(), Date.now() + 60000)
      .run();

    const response = await SELF.fetch(new Request(`https://beehive.test/connect/${token}`));
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("API Token");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(body).toContain("noindex");
  });

  it("does not accept an expired link", async () => {
    const { randomToken, sha256Hex } = await import("../../src/utils/ids");
    const token = randomToken(40);
    const user = await testEnv.DB.prepare(
      "INSERT INTO users (telegram_id, first_name, created_at, last_seen_at) VALUES (?, 'X', ?, ?) RETURNING id",
    )
      .bind(5301, Date.now(), Date.now())
      .first<{ id: number }>();
    await testEnv.DB.prepare(
      "INSERT INTO connect_links (token_hash, user_id, telegram_chat_id, status, created_at, expires_at) VALUES (?, ?, ?, 'pending', ?, ?)",
    )
      .bind(await sha256Hex(token), user!.id, 5301, Date.now(), Date.now() - 1000)
      .run();

    const response = await SELF.fetch(new Request(`https://beehive.test/connect/${token}`));
    expect(response.status).toBe(404);
  });

  it("rejects an obviously invalid token without calling Cloudflare", async () => {
    const { randomToken, sha256Hex } = await import("../../src/utils/ids");
    const token = randomToken(40);
    const user = await testEnv.DB.prepare(
      "INSERT INTO users (telegram_id, first_name, created_at, last_seen_at) VALUES (?, 'X', ?, ?) RETURNING id",
    )
      .bind(5302, Date.now(), Date.now())
      .first<{ id: number }>();
    await testEnv.DB.prepare(
      "INSERT INTO connect_links (token_hash, user_id, telegram_chat_id, status, created_at, expires_at) VALUES (?, ?, ?, 'pending', ?, ?)",
    )
      .bind(await sha256Hex(token), user!.id, 5302, Date.now(), Date.now() + 60000)
      .run();

    const response = await SELF.fetch(formRequest(`https://beehive.test/connect/${token}`, { token: "short" }));
    expect(response.status).toBe(400);
    const attempts = await testEnv.DB.prepare("SELECT attempts FROM connect_links WHERE token_hash = ?")
      .bind(await sha256Hex(token))
      .first<{ attempts: number }>();
    expect(attempts?.attempts).toBe(1);
  });

  it("connects an account through the full two-step flow", async () => {
    const { randomToken, sha256Hex } = await import("../../src/utils/ids");
    const { TEST_TOKEN } = await import("../helpers");
    const token = randomToken(40);
    const user = await testEnv.DB.prepare(
      "INSERT INTO users (telegram_id, first_name, created_at, last_seen_at) VALUES (?, 'X', ?, ?) RETURNING id",
    )
      .bind(5310, Date.now(), Date.now())
      .first<{ id: number }>();
    await testEnv.DB.prepare(
      "INSERT INTO connect_links (token_hash, user_id, telegram_chat_id, status, created_at, expires_at) VALUES (?, ?, ?, 'pending', ?, ?)",
    )
      .bind(await sha256Hex(token), user!.id, 5310, Date.now(), Date.now() + 60_000)
      .run();

    const response = await SELF.fetch(formRequest(`https://beehive.test/connect/${token}`, { token: TEST_TOKEN }));
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("حساب متصل شد");

    const account = await testEnv.DB.prepare("SELECT * FROM cloudflare_accounts WHERE user_id = ?")
      .bind(user!.id)
      .first<{ cloudflare_account_id: string; permissions_verified: number }>();
    expect(account?.cloudflare_account_id).toBe("0123456789abcdef0123456789abcdef");
    expect(account?.permissions_verified).toBe(1);

    // The plaintext token must not exist anywhere in the database.
    const credential = await testEnv.DB.prepare("SELECT ciphertext FROM encrypted_credentials WHERE user_id = ?")
      .bind(user!.id)
      .first<{ ciphertext: string }>();
    expect(credential?.ciphertext).not.toContain(TEST_TOKEN);
    const dump = JSON.stringify(
      await testEnv.DB.prepare("SELECT * FROM cloudflare_accounts").all(),
    );
    expect(dump).not.toContain(TEST_TOKEN);
  });
});

void seedUpdateRow;
