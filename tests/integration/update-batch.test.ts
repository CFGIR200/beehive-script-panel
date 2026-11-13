/**
 * Bulk panel update — "update all opened panels" (BEEHIVE-UPDALL-1).
 *
 * Covers: startUpdateBatch queueing with per-panel skip reasons (busy, current,
 * plan, concurrency, capacity), owner-chat routing for admin/cron-initiated
 * batches, the count/list repo helpers, and the cron auto-apply mode
 * (update_auto_apply) that queues update jobs instead of sending notices.
 * The data-safety contract (job plan never touches customer D1) is pinned in
 * update-notify.test.ts and applies to batch jobs unchanged — same step plan.
 */

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/config/env";
import { readConfig } from "../../src/config/env";
import { TelegramClient } from "../../src/bot/telegram";
import { runUpdateCheck } from "../../src/updates/notify";
import { startUpdateBatch } from "../../src/provisioning/engine";
import { stepNames } from "../../src/provisioning/planner";
import * as panelsRepo from "../../src/database/repositories/panels";
import * as jobsRepo from "../../src/database/repositories/jobs";
import { restoreFetch, seedAccount, seedUser } from "../helpers";

const testEnv = env as unknown as Env;
const config = readConfig(testEnv);

interface SentNotice {
  chatId: number;
  text: string;
}

let sent: SentNotice[] = [];

function mockTelegramFetch(): void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).includes("api.telegram.org")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { chat_id?: number; text?: string };
      sent.push({ chatId: Number(body.chat_id), text: body.text ?? "" });
      return new Response(
        JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: body.chat_id, type: "private" }, date: 0 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return original(url as never, init as never);
  }) as typeof fetch;
}

/** Inserts an active panel owned by `user` with the given installed version/build. */
async function seedPanel(
  userId: number,
  accountRef: number,
  workerName: string,
  options: { version?: string | null; status?: string; artifactSha256?: string | null } = {},
): Promise<number> {
  const ts = Date.now();
  const result = await testEnv.DB.prepare(
    `INSERT INTO panels (uid, user_id, account_ref, cloudflare_account_id, worker_name, d1_database_name,
        status, version, artifact_sha256, deleted_at, updated_at)
     VALUES (?, ?, ?, 'acc-test', ?, 'db-test', ?, ?, ?, NULL, ?)`,
  )
    .bind(
      `uid-${workerName}`,
      userId,
      accountRef,
      workerName,
      options.status ?? "active",
      options.version === undefined ? "3.1.12" : options.version,
      options.artifactSha256 === undefined ? null : options.artifactSha256,
      ts,
    )
    .run();
  return Number(result.meta.last_row_id);
}

async function seedBusyJob(userId: number, panelId: number): Promise<void> {
  await jobsRepo.create(testEnv, {
    id: `busy-${panelId}`,
    userId,
    panelId,
    accountRef: null,
    kind: "backup",
    payload: {},
    traceId: "trace-busy",
    telegramChatId: null,
    steps: stepNames("backup"),
  });
}

/** Restores plan defaults mutated by individual tests and clears queue state. */
async function resetState(): Promise<void> {
  await testEnv.DB.prepare("UPDATE subscription_plans SET allow_update = 1, max_concurrent_jobs = 1 WHERE code = 'free'").run();
  await testEnv.DB.prepare("DELETE FROM system_settings WHERE key LIKE 'update_%' OR key = 'max_global_concurrency'").run();
  await testEnv.DB.prepare("DELETE FROM deployment_steps").run();
  await testEnv.DB.prepare("DELETE FROM deployment_jobs").run();
}

beforeEach(async () => {
  restoreFetch();
  sent = [];
  mockTelegramFetch();
  await resetState();
});

describe("startUpdateBatch", () => {
  it("queues an update job for every outdated panel and routes progress to the caller's chat", async () => {
    const user = await seedUser(9201, "updall-owner");
    const account = await seedAccount(user.id);
    await testEnv.DB.prepare("UPDATE subscription_plans SET max_concurrent_jobs = 3 WHERE code = 'free'").run();
    const panelA = await seedPanel(user.id, account.id, "bee-all-a");
    const panelB = await seedPanel(user.id, account.id, "bee-all-b");

    const batch = await startUpdateBatch(testEnv, config, {
      panelIds: [panelA, panelB],
      actorType: "telegram_user",
      actorId: user.id,
      telegramChatId: 4242,
    });

    expect(batch.queued.map((item) => item.panelId).sort()).toEqual([panelA, panelB].sort());
    expect(batch.skipped).toEqual([]);
    expect(batch.capacityReached).toBe(false);

    for (const item of batch.queued) {
      const job = await jobsRepo.findById(testEnv, item.jobId);
      expect(job?.kind).toBe("update");
      expect(job?.user_id).toBe(user.id);
      expect(job?.telegram_chat_id).toBe(4242);
      const panel = await panelsRepo.findById(testEnv, item.panelId);
      expect(panel?.status).toBe("updating");
    }
  });

  it("skips current and busy panels with the right reasons", async () => {
    const user = await seedUser(9202, "updall-skip");
    const account = await seedAccount(user.id);
    // "Current" needs BOTH the version and the approved build digest — a panel
    // seeded without the digest is treated as running the unpatched build.
    const current = await seedPanel(user.id, account.id, "bee-all-current", {
      version: config.artifactVersion,
      artifactSha256: config.artifactSha256,
    });
    const busy = await seedPanel(user.id, account.id, "bee-all-busy");
    await seedBusyJob(user.id, busy);

    const batch = await startUpdateBatch(testEnv, config, {
      panelIds: [current, busy],
      actorType: "telegram_user",
      actorId: user.id,
      telegramChatId: null,
    });

    expect(batch.queued).toEqual([]);
    expect(Object.fromEntries(batch.skipped.map((item) => [item.panelId, item.reason]))).toEqual({
      [current]: "current",
      [busy]: "busy",
    });
  });

  it("skips panels whose owner's plan disallows updates", async () => {
    const user = await seedUser(9203, "updall-plan");
    const account = await seedAccount(user.id);
    await testEnv.DB.prepare("UPDATE subscription_plans SET allow_update = 0 WHERE code = 'free'").run();
    const panel = await seedPanel(user.id, account.id, "bee-all-plan");

    const batch = await startUpdateBatch(testEnv, config, {
      panelIds: [panel],
      actorType: "telegram_user",
      actorId: user.id,
      telegramChatId: null,
    });

    expect(batch.queued).toEqual([]);
    expect(batch.skipped).toEqual([{ panelId: panel, workerName: "bee-all-plan", reason: "plan" }]);
  });

  it("respects the owner's per-user concurrency limit before queueing", async () => {
    const user = await seedUser(9204, "updall-conc");
    const account = await seedAccount(user.id);
    const first = await seedPanel(user.id, account.id, "bee-all-conc-1");
    const second = await seedPanel(user.id, account.id, "bee-all-conc-2");

    // free plan allows exactly 1 concurrent job: the first queues, the second
    // is reported (not silently dropped), capacity stays untouched.
    const batch = await startUpdateBatch(testEnv, config, {
      panelIds: [first, second],
      actorType: "telegram_user",
      actorId: user.id,
      telegramChatId: null,
    });

    expect(batch.queued.map((item) => item.panelId)).toEqual([first]);
    expect(batch.skipped).toEqual([{ panelId: second, workerName: "bee-all-conc-2", reason: "concurrency" }]);
  });

  it("stops at the global concurrency cap and reports capacity", async () => {
    const other = await seedUser(9205, "updall-cap-other");
    const otherAccount = await seedAccount(other.id);
    const otherPanel = await seedPanel(other.id, otherAccount.id, "bee-all-cap-other");
    await seedBusyJob(other.id, otherPanel); // occupies the single global slot

    const user = await seedUser(9206, "updall-cap");
    const account = await seedAccount(user.id);
    const panel = await seedPanel(user.id, account.id, "bee-all-cap");
    await testEnv.DB.prepare(
      "INSERT INTO system_settings (key, value, updated_at) VALUES ('max_global_concurrency', '1', 0) " +
        "ON CONFLICT (key) DO UPDATE SET value = '1'",
    ).run();

    const batch = await startUpdateBatch(testEnv, config, {
      panelIds: [panel],
      actorType: "telegram_user",
      actorId: user.id,
      telegramChatId: null,
    });

    expect(batch.queued).toEqual([]);
    expect(batch.capacityReached).toBe(true);
    expect(batch.skipped).toEqual([{ panelId: panel, workerName: "bee-all-cap", reason: "capacity" }]);
  });

  it("routes progress to each panel owner's own chat when no chat is given", async () => {
    const userA = await seedUser(9207, "updall-chat-a");
    const accountA = await seedAccount(userA.id);
    const panelA = await seedPanel(userA.id, accountA.id, "bee-all-chat-a");
    const userB = await seedUser(9208, "updall-chat-b");
    const accountB = await seedAccount(userB.id);
    const panelB = await seedPanel(userB.id, accountB.id, "bee-all-chat-b");

    const batch = await startUpdateBatch(testEnv, config, {
      panelIds: [panelA, panelB],
      actorType: "system",
      actorId: null,
      telegramChatId: null,
    });

    expect(batch.queued.length).toBe(2);
    const jobA = await jobsRepo.findById(testEnv, batch.queued[0]!.jobId);
    const jobB = await jobsRepo.findById(testEnv, batch.queued[1]!.jobId);
    const expectedChat = (panelId: number) =>
      panelId === panelA ? userA.telegram_id : userB.telegram_id;
    expect(jobA?.telegram_chat_id).toBe(expectedChat(batch.queued[0]!.panelId));
    expect(jobB?.telegram_chat_id).toBe(expectedChat(batch.queued[1]!.panelId));
  });
  it("queues an update for a panel on the right version but a stale build", async () => {
    // The patched and unpatched 3.1.13 bundles share one version string. A
    // panel installed from the original vendor build (no digest recorded) must
    // NOT be treated as current — the batch has to bring it to the patched
    // artifact or the customer would never receive the BEEHIVE patches.
    const user = await seedUser(9212, "updall-stale");
    const account = await seedAccount(user.id);
    const stale = await seedPanel(user.id, account.id, "bee-all-stale", { version: config.artifactVersion });

    const batch = await startUpdateBatch(testEnv, config, {
      panelIds: [stale],
      actorType: "telegram_user",
      actorId: user.id,
      telegramChatId: null,
    });

    expect(batch.queued.map((item) => item.panelId)).toEqual([stale]);
    expect(batch.skipped).toEqual([]);
    const job = await jobsRepo.findById(testEnv, batch.queued[0]!.jobId);
    expect(job?.kind).toBe("update");
  });
});

describe("bulk update repo helpers", () => {
  it("lists and counts outdated panels per user and system-wide", async () => {
    const user = await seedUser(9209, "updall-count");
    const account = await seedAccount(user.id);
    const outdated = await seedPanel(user.id, account.id, "bee-count-old");
    await seedPanel(user.id, account.id, "bee-count-new", {
      version: config.artifactVersion,
      artifactSha256: config.artifactSha256,
    });

    expect(await panelsRepo.countOutdatedForUser(testEnv, user.id, config.artifactVersion, config.artifactSha256)).toBe(1);
    expect(
      (await panelsRepo.listOutdatedForUser(testEnv, { userId: user.id, latestVersion: config.artifactVersion, expectedSha256: config.artifactSha256 })).map((row) => row.id),
    ).toEqual([outdated]);
    expect(await panelsRepo.countOutdatedAll(testEnv, config.artifactVersion, config.artifactSha256)).toBeGreaterThanOrEqual(1);
    const allRows = await panelsRepo.listOutdatedAll(testEnv, { latestVersion: config.artifactVersion, expectedSha256: config.artifactSha256, limit: 200 });
    expect(allRows.find((row) => row.id === outdated)?.user_telegram_id).toBe(user.telegram_id);
  });

  it("treats a same-version panel with a stale or missing build digest as outdated", async () => {
    const user = await seedUser(9213, "updall-digest");
    const account = await seedAccount(user.id);
    const stale = await seedPanel(user.id, account.id, "bee-digest-stale", { version: config.artifactVersion });

    expect(await panelsRepo.countOutdatedForUser(testEnv, user.id, config.artifactVersion, config.artifactSha256)).toBe(1);

    // Converges after the approved digest is recorded (what the update job's
    // finalize step does).
    await testEnv.DB.prepare("UPDATE panels SET artifact_sha256 = ? WHERE id = ?")
      .bind(config.artifactSha256, stale)
      .run();
    expect(await panelsRepo.countOutdatedForUser(testEnv, user.id, config.artifactVersion, config.artifactSha256)).toBe(0);
  });
});

describe("auto-apply (update_auto_apply)", () => {
  it("queues update jobs for outdated panels instead of sending notices", async () => {
    const user = await seedUser(9210, "updall-auto");
    const account = await seedAccount(user.id);
    const panel = await seedPanel(user.id, account.id, "bee-all-auto");

    await testEnv.DB.prepare(
      "INSERT INTO system_settings (key, value, updated_at) VALUES ('update_auto_apply', '1', 0) " +
        "ON CONFLICT (key) DO UPDATE SET value = '1'",
    ).run();

    const telegram = new TelegramClient(testEnv.TELEGRAM_BOT_TOKEN, { traceId: "test_auto_apply" });
    const result = await runUpdateCheck(testEnv, config, telegram);

    expect(result).toMatchObject({ enabled: true, throttled: false, outdated: 1, applied: 1, notified: 0 });
    expect(sent).toEqual([]); // no separate notice — the job pipeline informs the owner

    const panelRow = await panelsRepo.findById(testEnv, panel);
    expect(panelRow?.status).toBe("updating");
    const active = await jobsRepo.activeJobForPanel(testEnv, panel);
    expect(active?.kind).toBe("update");
    expect(active?.telegram_chat_id).toBe(user.telegram_id);
  });

  it("respects the update_apply_batch cap per pass", async () => {
    const user = await seedUser(9211, "updall-autobatch");
    const account = await seedAccount(user.id);
    await testEnv.DB.prepare("UPDATE subscription_plans SET max_concurrent_jobs = 5 WHERE code = 'free'").run();
    await seedPanel(user.id, account.id, "bee-auto-b1");
    await seedPanel(user.id, account.id, "bee-auto-b2");
    await seedPanel(user.id, account.id, "bee-auto-b3");

    await testEnv.DB.prepare(
      "INSERT INTO system_settings (key, value, updated_at) VALUES ('update_auto_apply', '1', 0), ('update_apply_batch', '2', 0) " +
        "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    ).run();

    const telegram = new TelegramClient(testEnv.TELEGRAM_BOT_TOKEN, { traceId: "test_auto_apply_batch" });
    const result = await runUpdateCheck(testEnv, config, telegram);

    expect(result.outdated).toBe(2);
    expect(result.applied).toBe(2);
  });
});
