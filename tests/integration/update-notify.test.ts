/**
 * Panel update notifications (src/updates/notify.ts).
 *
 * Covers: notice delivery with the one-tap update button, per-panel dedupe,
 * reminder interval, throttle, batch cap, and every skip condition (disabled,
 * registry-inactive latest version, blocked owner, non-active panel).
 * Also pins the "data survives an update" guarantee at the job-plan level.
 */

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/config/env";
import { readConfig } from "../../src/config/env";
import { TelegramClient } from "../../src/bot/telegram";
import { runUpdateCheck } from "../../src/updates/notify";
import { planFor } from "../../src/provisioning/planner";
import * as settingsRepo from "../../src/database/repositories/settings";
import * as panelsRepo from "../../src/database/repositories/panels";
import { restoreFetch, seedAccount, seedUser } from "../helpers";

const testEnv = env as unknown as Env;
const config = readConfig(testEnv);
const telegram = new TelegramClient(testEnv.TELEGRAM_BOT_TOKEN, { traceId: "test_update_notify" });

interface SentNotice {
  chatId: number;
  text: string;
  raw: string;
}

let sent: SentNotice[] = [];

function mockTelegramFetch(): void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).includes("api.telegram.org")) {
      const raw = String(init?.body ?? "{}");
      const body = JSON.parse(raw) as { chat_id?: number; text?: string };
      sent.push({ chatId: Number(body.chat_id), text: body.text ?? "", raw });
      return new Response(
        JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: body.chat_id, type: "private" }, date: 0 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return original(url as never, init as never);
  }) as typeof fetch;
}

/** Resets the notification settings to their code defaults (no rows). */
async function resetNotifySettings(): Promise<void> {
  await testEnv.DB.prepare("DELETE FROM system_settings WHERE key LIKE 'update_%'").run();
}

/** Inserts an active panel owned by `user` with the given installed version. */
async function seedPanel(
  userId: number,
  accountRef: number,
  workerName: string,
  options: {
    version?: string | null;
    status?: string;
    notified?: string | null;
    noticeAt?: number | null;
    deleted?: boolean;
  } = {},
): Promise<number> {
  const now = Date.now();
  const result = await testEnv.DB.prepare(
    `INSERT INTO panels (uid, user_id, account_ref, cloudflare_account_id, worker_name, d1_database_name,
        status, version, update_notified_version, update_notice_at, deleted_at, updated_at)
     VALUES (?, ?, ?, 'acc-test', ?, 'db-test', ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      `uid-${workerName}`,
      userId,
      accountRef,
      workerName,
      options.status ?? "active",
      options.version === undefined ? "3.1.12" : options.version,
      options.notified ?? null,
      options.noticeAt ?? null,
      options.deleted ? now : null,
      now,
    )
    .run();
  return Number(result.meta.last_row_id);
}

async function seedSetup(telegramId: number, username: string): Promise<{ userId: number; accountRef: number; telegramId: number }> {
  const user = await seedUser(telegramId, username);
  const account = await seedAccount(user.id);
  return { userId: user.id, accountRef: account.id, telegramId };
}

beforeEach(async () => {
  restoreFetch();
  sent = [];
  mockTelegramFetch();
  await resetNotifySettings();
});

describe("update notifications", () => {
  it("notifies the owner of an outdated panel with a one-tap update button", async () => {
    const setup = await seedSetup(9101, "upd-owner");
    const panelId = await seedPanel(setup.userId, setup.accountRef, "bee-upd-1");

    const result = await runUpdateCheck(testEnv, config, telegram);
    expect(result).toMatchObject({ enabled: true, throttled: false, outdated: 1, notified: 1, failed: 0 });
    expect(sent.length).toBe(1);
    expect(sent[0]!.chatId).toBe(setup.telegramId);
    expect(sent[0]!.text).toContain("bee-upd-1");
    expect(sent[0]!.text).toContain("3.1.12");
    expect(sent[0]!.text).toContain(config.artifactVersion);
    expect(sent[0]!.raw).toContain(`panel:update_go:${panelId}`);
    expect(sent[0]!.raw).toContain(`panel:view:${panelId}`);

    const panel = await panelsRepo.findById(testEnv, panelId);
    expect(panel?.update_notified_version).toBe(config.artifactVersion);
    expect(panel?.update_notice_at).not.toBeNull();
  });

  it("does not re-notify for the same target version", async () => {
    const setup = await seedSetup(9102, "upd-dedupe");
    await seedPanel(setup.userId, setup.accountRef, "bee-upd-2");

    const first = await runUpdateCheck(testEnv, config, telegram);
    expect(first.notified).toBe(1);

    const second = await runUpdateCheck(testEnv, config, telegram);
    expect(second.notified).toBe(0);
    expect(sent.length).toBe(1);
  });

  it("re-notifies once the reminder interval has passed", async () => {
    const setup = await seedSetup(9103, "upd-remind");
    const yesterday = Date.now() - 25 * 60 * 60 * 1000;
    await seedPanel(setup.userId, setup.accountRef, "bee-upd-3", {
      notified: config.artifactVersion,
      noticeAt: yesterday,
    });

    const result = await runUpdateCheck(testEnv, config, telegram);
    expect(result.notified).toBe(1);
    expect(sent.length).toBe(1);
  });

  it("skips current, deleted, non-active and blocked-owner panels", async () => {
    const owner = await seedSetup(9104, "upd-skip");
    const blocked = await seedSetup(9105, "upd-blocked");
    await testEnv.DB.prepare("UPDATE users SET is_blocked = 1 WHERE id = ?").bind(blocked.userId).run();

    await seedPanel(owner.userId, owner.accountRef, "bee-current", { version: config.artifactVersion });
    await seedPanel(owner.userId, owner.accountRef, "bee-deleted", { deleted: true });
    await seedPanel(owner.userId, owner.accountRef, "bee-updating", { status: "updating" });
    await seedPanel(owner.userId, owner.accountRef, "bee-failed", { status: "failed" });
    await seedPanel(blocked.userId, blocked.accountRef, "bee-blocked-owner");

    const result = await runUpdateCheck(testEnv, config, telegram);
    expect(result.outdated).toBe(0);
    expect(result.notified).toBe(0);
    expect(sent.length).toBe(0);
  });

  it("respects the per-pass batch cap", async () => {
    await settingsRepo.set(testEnv, "update_notify_batch", "2");
    // Consecutive passes must run without waiting for the check throttle.
    await settingsRepo.set(testEnv, "update_check_min_minutes", "0");
    const setup = await seedSetup(9106, "upd-batch");
    await seedPanel(setup.userId, setup.accountRef, "bee-batch-a");
    await seedPanel(setup.userId, setup.accountRef, "bee-batch-b");
    await seedPanel(setup.userId, setup.accountRef, "bee-batch-c");

    const result = await runUpdateCheck(testEnv, config, telegram);
    expect(result.outdated).toBe(2);
    expect(result.notified).toBe(2);
    expect(sent.length).toBe(2);

    // The next pass picks up the remaining panel.
    const followup = await runUpdateCheck(testEnv, config, telegram);
    expect(followup.outdated).toBe(1);
    expect(followup.notified).toBe(1);
  });

  it("is disabled by the update_notify_enabled setting", async () => {
    await settingsRepo.set(testEnv, "update_notify_enabled", "0");
    const setup = await seedSetup(9107, "upd-off");
    await seedPanel(setup.userId, setup.accountRef, "bee-off");

    const result = await runUpdateCheck(testEnv, config, telegram);
    expect(result.enabled).toBe(false);
    expect(sent.length).toBe(0);
    const panel = await testEnv.DB.prepare("SELECT update_notified_version FROM panels WHERE uid = 'uid-bee-off'").first<{ update_notified_version: string | null }>();
    expect(panel?.update_notified_version).toBeNull();
  });

  it("never notifies when the target version is not active in the registry", async () => {
    await testEnv.DB.prepare("UPDATE panel_versions SET is_active = 0 WHERE version = ?").bind(config.artifactVersion).run();
    const setup = await seedSetup(9108, "upd-registry");
    await seedPanel(setup.userId, setup.accountRef, "bee-registry");

    try {
      const result = await runUpdateCheck(testEnv, config, telegram);
      expect(result.outdated).toBe(0);
      expect(result.notified).toBe(0);
      expect(sent.length).toBe(0);
    } finally {
      await testEnv.DB.prepare("UPDATE panel_versions SET is_active = 1 WHERE version = ?").bind(config.artifactVersion).run();
    }
  });

  it("throttles repeated checks to update_check_min_minutes", async () => {
    const setup = await seedSetup(9109, "upd-throttle");
    await seedPanel(setup.userId, setup.accountRef, "bee-throttle");

    const first = await runUpdateCheck(testEnv, config, telegram);
    expect(first.throttled).toBe(false);
    expect(first.notified).toBe(1);

    // Default throttle is 30 minutes and the timestamp was just written.
    const second = await runUpdateCheck(testEnv, config, telegram);
    expect(second.throttled).toBe(true);
    expect(sent.length).toBe(1);
  });
});

describe("update data-safety contract", () => {
  it("the update/redeploy job plan never contains destructive or data-touching steps", () => {
    for (const kind of ["update", "redeploy"] as const) {
      const names = planFor(kind).steps.map((step) => step.name);
      expect(names).toContain("upload_worker");
      for (const forbidden of ["create_database", "delete_database", "restore_database", "export_database", "mark_deleted", "delete_worker"]) {
        expect(names).not.toContain(forbidden);
      }
    }
  });
});
