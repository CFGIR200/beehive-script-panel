/**
 * End-to-end provisioning against a mocked Cloudflare API.
 *
 * Covers: install happy path, resume after a transient failure, integrity
 * rejection, delete with ownership checks, backup, and rollback of a partial
 * install. The D1/KV/R2 layer is the real Miniflare implementation.
 */

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/config/env";
import { readConfig } from "../../src/config/env";
import * as engine from "../../src/provisioning/engine";
import { drain, runJobToCompletion } from "../../src/provisioning/executor";
import * as panelsRepo from "../../src/database/repositories/panels";
import * as jobsRepo from "../../src/database/repositories/jobs";
import * as auditRepo from "../../src/database/repositories/audit";
import { installCloudflareMock, registerTestArtifact, restoreFetch, seedAccount, seedUser } from "../helpers";

const testEnv = env as unknown as Env;
const config = readConfig(testEnv);

async function freshTenant(telegramId: number) {
  const user = await seedUser(telegramId, `user${telegramId}`);
  const account = await seedAccount(user.id);
  return { user, account };
}

beforeEach(async () => {
  restoreFetch();
  await registerTestArtifact();
});

describe("install job", () => {
  it("creates D1, uploads the worker, enables workers.dev, sets cron and verifies", async () => {
    const mock = installCloudflareMock();
    const { user, account } = await freshTenant(9001);

    const started = await engine.startInstall(testEnv, config, {
      userId: user.id,
      telegramChatId: 9001,
      accountRef: account.id,
    });
    expect(started.job.kind).toBe("install");
    expect(started.job.steps_total).toBe(8);

    const result = await runJobToCompletion(testEnv, config, started.job.id);

    expect(result.outcome).toBe("completed");
    const panel = await panelsRepo.findByUid(testEnv, started.panel!.uid);
    expect(panel?.status).toBe("active");
    expect(panel?.panel_url).toBe(`https://${panel?.worker_name}.testsub.workers.dev/panel`);
    expect(panel?.d1_database_id).toBe("d1-aaaa-bbbb-cccc-ddddeeeeffff");
    expect(panel?.recovery_key_sealed).toBeTruthy();
    // The recovery key is sealed, never stored in clear text.
    expect(panel?.recovery_key_sealed).not.toContain("RECOVERY_KEY");

    const resources = await panelsRepo.liveResourcesOf(testEnv, panel!.id);
    const kinds = resources.map((resource) => resource.kind).sort();
    expect(kinds).toEqual(["cron_trigger", "d1_database", "worker_script", "workers_dev"]);

    // Cloudflare was actually asked to do the right things.
    expect(mock.uploadCount).toBe(1);
    const upload = mock.calls.find((call) => call.method === "PUT" && call.url.includes("/workers/scripts/"));
    expect(upload?.headers["authorization"]).toMatch(/^Bearer /);
    const schedule = mock.calls.find((call) => call.url.endsWith("/schedules"));
    expect(schedule).toBeTruthy();

    // Audit trail exists for the start of the install.
    const logs = await auditRepo.list(testEnv, { limit: 10, offset: 0 });
    expect(logs.some((log) => log.action === "panel.install.started")).toBe(true);
  });

  it("resumes after a transient upload failure", async () => {
    const mock = installCloudflareMock({ failUploadTimes: 1 });
    const { user, account } = await freshTenant(9002);

    const started = await engine.startInstall(testEnv, config, {
      userId: user.id,
      telegramChatId: 9002,
      accountRef: account.id,
    });

    // First pass fails on upload with a retryable 503.
    let outcome = await runJobToCompletion(testEnv, config, started.job.id, 4000);
    const afterFirst = await jobsRepo.findById(testEnv, started.job.id);
    expect(["retry", "completed"]).toContain(outcome.outcome);
    if (afterFirst?.status !== "completed") {
      expect(afterFirst?.attempt).toBeGreaterThan(0);
      outcome = await runJobToCompletion(testEnv, config, started.job.id, 6000);
    }

    const final = await jobsRepo.findById(testEnv, started.job.id);
    expect(final?.status).toBe("completed");
    expect(mock.uploadCount).toBe(1);
  });

  it("refuses to deploy an artifact whose hash does not match the registry", async () => {
    installCloudflareMock();
    const { user, account } = await freshTenant(9003);

    // Corrupt the approved hash for the version under test.
    await env.DB.prepare("UPDATE panel_versions SET artifact_sha256 = ? WHERE version = ?")
      .bind("0".repeat(64), config.artifactVersion)
      .run();

    const started = await engine.startInstall(testEnv, config, {
      userId: user.id,
      telegramChatId: 9003,
      accountRef: account.id,
    });
    await runJobToCompletion(testEnv, config, started.job.id);

    const job = await jobsRepo.findById(testEnv, started.job.id);
    expect(job?.status).toBe("rolled_back");
    expect(job?.error_code).toBe("ARTIFACT_INTEGRITY");

    const panel = await panelsRepo.findById(testEnv, started.panel!.id);
    expect(panel?.status).toBe("failed");
  });

  it("rolls back created resources when the panel never becomes reachable", async () => {
    const mock = installCloudflareMock({
      override: (call) =>
        call.url.includes(".workers.dev/")
          ? new Response("<html><body>not the panel</body></html>", { status: 200 })
          : null,
    });
    const { user, account } = await freshTenant(9004);

    const started = await engine.startInstall(testEnv, config, {
      userId: user.id,
      telegramChatId: 9004,
      accountRef: account.id,
    });
    await runJobToCompletion(testEnv, config, started.job.id, 6000);

    const job = await jobsRepo.findById(testEnv, started.job.id);
    expect(job?.status).toBe("rolled_back");
    // The worker and the database this job created were deleted again.
    expect(mock.deletedWorkers.length).toBe(1);
    expect(mock.deletedDatabases.length).toBe(1);
  });

  it("enforces the plan panel limit", async () => {
    installCloudflareMock();
    const { user, account } = await freshTenant(9005);

    const first = await engine.startInstall(testEnv, config, {
      userId: user.id,
      telegramChatId: 9005,
      accountRef: account.id,
    });
    await runJobToCompletion(testEnv, config, first.job.id);
    expect((await panelsRepo.findById(testEnv, first.panel!.id))?.status).toBe("active");

    // `free` allows exactly one panel.
    await expect(
      engine.startInstall(testEnv, config, { userId: user.id, telegramChatId: 9005, accountRef: account.id }),
    ).rejects.toMatchObject({ code: "LIMIT_REACHED" });
  });

  it("refuses a worker name that is already used in the account", async () => {
    installCloudflareMock();
    const { user, account } = await freshTenant(9006);
    const first = await engine.startInstall(testEnv, config, {
      userId: user.id,
      telegramChatId: 9006,
      accountRef: account.id,
    });
    await runJobToCompletion(testEnv, config, first.job.id);
    const taken = first.workerName!;

    // Grant a bigger plan so the limit is not the reason for failure.
    await env.DB.prepare("UPDATE subscription_plans SET max_panels = 5 WHERE code = 'free'").run();
    await expect(
      engine.startInstall(testEnv, config, {
        userId: user.id,
        telegramChatId: 9006,
        accountRef: account.id,
        requestedWorkerName: taken,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("panel lifecycle", () => {
  it("updates, backs up and deletes a panel", async () => {
    const mock = installCloudflareMock();
    const { user, account } = await freshTenant(9010);
    await env.DB.prepare("UPDATE subscription_plans SET allow_backup = 1 WHERE code = 'free'").run();

    const started = await engine.startInstall(testEnv, config, {
      userId: user.id,
      telegramChatId: 9010,
      accountRef: account.id,
    });
    await runJobToCompletion(testEnv, config, started.job.id);
    const panel = (await panelsRepo.findById(testEnv, started.panel!.id))!;

    // --- redeploy (same version) ---------------------------------------
    const redeploy = await engine.startUpdate(testEnv, config, {
      userId: user.id,
      telegramChatId: 9010,
      panelId: panel.id,
      redeploy: true,
    });
    const redeployResult = await runJobToCompletion(testEnv, config, redeploy.job.id);
    expect(redeployResult.outcome).toBe("completed");
    expect(mock.uploadCount).toBe(2);

    // --- backup ---------------------------------------------------------
    const backup = await engine.startBackup(testEnv, config, {
      userId: user.id,
      telegramChatId: 9010,
      panelId: panel.id,
    });
    await runJobToCompletion(testEnv, config, backup.job.id);
    const backups = await panelsRepo.listBackups(testEnv, panel.id, user.id);
    expect(backups[0]?.status).toBe("completed");
    const object = await env.ARTIFACTS!.get(backups[0]!.object_key!);
    expect(await object?.text()).toContain("CREATE TABLE users");

    // --- restore --------------------------------------------------------
    const restore = await engine.startRestore(testEnv, config, {
      userId: user.id,
      telegramChatId: 9010,
      panelId: panel.id,
      backupId: backups[0]!.id,
    });
    await runJobToCompletion(testEnv, config, restore.job.id);
    const importCall = mock.calls.find((call) => call.url.endsWith("/import") && call.body?.includes("ingest"));
    expect(importCall).toBeTruthy();

    // --- delete ---------------------------------------------------------
    const deletion = await engine.startDelete(testEnv, config, {
      userId: user.id,
      telegramChatId: 9010,
      panelId: panel.id,
    });
    const deleteResult = await runJobToCompletion(testEnv, config, deletion.job.id);
    expect(deleteResult.outcome).toBe("completed");

    const afterDelete = await panelsRepo.findById(testEnv, panel.id);
    expect(afterDelete?.status).toBe("deleted");
    expect(afterDelete?.recovery_key_sealed).toBeNull();
    expect(mock.deletedWorkers).toContain(panel.worker_name);
    expect(mock.deletedDatabases).toContain(panel.d1_database_id);
  });

  it("does not delete a worker it did not record itself", async () => {
    installCloudflareMock();
    const { user, account } = await freshTenant(9011);
    const started = await engine.startInstall(testEnv, config, {
      userId: user.id,
      telegramChatId: 9011,
      accountRef: account.id,
    });
    await runJobToCompletion(testEnv, config, started.job.id);
    const panel = (await panelsRepo.findById(testEnv, started.panel!.id))!;

    // An attacker (or a bug) rewrites the tracked worker name.
    await env.DB.prepare("UPDATE panel_resources SET external_id = 'someone-elses-worker' WHERE panel_id = ? AND kind = 'worker_script'")
      .bind(panel.id)
      .run();

    const deletion = await engine.startDelete(testEnv, config, {
      userId: user.id,
      telegramChatId: 9011,
      panelId: panel.id,
    });
    await runJobToCompletion(testEnv, config, deletion.job.id);

    const job = await jobsRepo.findById(testEnv, deletion.job.id);
    expect(job?.status).not.toBe("completed");
    expect(job?.error_code).toBe("FORBIDDEN");
  });

  it("reports a degraded panel when the panel stops answering", async () => {
    installCloudflareMock();
    const { user, account } = await freshTenant(9012);
    const started = await engine.startInstall(testEnv, config, {
      userId: user.id,
      telegramChatId: 9012,
      accountRef: account.id,
    });
    await runJobToCompletion(testEnv, config, started.job.id);
    const panel = (await panelsRepo.findById(testEnv, started.panel!.id))!;

    restoreFetch();
    installCloudflareMock({ override: () => new Response("down", { status: 502 }) });

    const { checkAndRecord } = await import("../../src/panels/health");
    const health = await checkAndRecord(testEnv, panel);
    expect(health.ok).toBe(false);
    const after = await panelsRepo.findById(testEnv, panel.id);
    expect(after?.status).toBe("degraded");
    expect(after?.last_health_status).toBe("degraded");
  });
});

describe("executor safety", () => {
  it("does not run the same job twice concurrently (lease)", async () => {
    installCloudflareMock();
    const { user, account } = await freshTenant(9020);
    const started = await engine.startInstall(testEnv, config, {
      userId: user.id,
      telegramChatId: 9020,
      accountRef: account.id,
    });

    // Simulate an in-flight lease held by another invocation.
    await env.DB.prepare("UPDATE deployment_jobs SET lease_owner = 'other', locked_until = ? WHERE id = ?")
      .bind(Date.now() + 60_000, started.job.id)
      .run();

    const drained = await drain(testEnv, config, 1500);
    expect(drained.find((entry) => entry.jobId === started.job.id)).toBeUndefined();

    const job = await jobsRepo.findById(testEnv, started.job.id);
    expect(job?.status).toBe("pending");
  });

  it("cancels a queued job", async () => {
    installCloudflareMock();
    const { user, account } = await freshTenant(9021);
    const started = await engine.startInstall(testEnv, config, {
      userId: user.id,
      telegramChatId: 9021,
      accountRef: account.id,
    });
    expect(await engine.cancelJob(testEnv, started.job.id, user.id)).toBe(true);
    const job = await jobsRepo.findById(testEnv, started.job.id);
    expect(job?.status).toBe("cancelled");
    // A cancelled job is never picked up again.
    await drain(testEnv, config, 500);
    expect((await jobsRepo.findById(testEnv, started.job.id))?.status).toBe("cancelled");
  });
});
