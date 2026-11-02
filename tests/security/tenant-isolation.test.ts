/**
 * Tenant isolation and authorisation tests.
 *
 * These are the tests that must never regress: user A must not be able to read,
 * manage, or delete anything that belongs to user B, and non-staff users must not
 * reach admin surfaces.
 */

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/config/env";
import { readConfig } from "../../src/config/env";
import * as engine from "../../src/provisioning/engine";
import { runJobToCompletion } from "../../src/provisioning/executor";
import * as panelsRepo from "../../src/database/repositories/panels";
import * as accountsRepo from "../../src/database/repositories/accounts";
import * as jobsRepo from "../../src/database/repositories/jobs";
import * as usersRepo from "../../src/database/repositories/users";
import * as manager from "../../src/panels/manager";
import { loadConnection } from "../../src/auth/cloudflare-auth";
import { installCloudflareMock, registerTestArtifact, restoreFetch, seedAccount, seedUser } from "../helpers";

const testEnv = env as unknown as Env;
const config = readConfig(testEnv);

async function installedPanel(telegramId: number) {
  installCloudflareMock();
  await registerTestArtifact();
  const user = await seedUser(telegramId, `u${telegramId}`);
  const account = await seedAccount(user.id);
  const started = await engine.startInstall(testEnv, config, {
    userId: user.id,
    telegramChatId: telegramId,
    accountRef: account.id,
  });
  await runJobToCompletion(testEnv, config, started.job.id);
  const panel = (await panelsRepo.findById(testEnv, started.panel!.id))!;
  return { user, account, panel };
}

beforeEach(() => {
  restoreFetch();
});

describe("cross-tenant access", () => {
  it("cannot read another user's panel", async () => {
    const owner = await installedPanel(3001);
    const intruder = await seedUser(3002, "intruder");

    expect(await panelsRepo.findForUser(testEnv, intruder.id, owner.panel.id)).toBeNull();
    expect(await manager.viewForUser(testEnv, intruder.id, owner.panel.id)).toBeNull();
    const list = await manager.listViewsForUser(testEnv, intruder.id);
    expect(list).toHaveLength(0);
  });

  it("cannot load another user's Cloudflare credential", async () => {
    const owner = await installedPanel(3010);
    const intruder = await seedUser(3011, "intruder2");
    await expect(
      loadConnection(testEnv, config, intruder.id, owner.account.id, "trace-test"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("cannot start a job against another user's account", async () => {
    const owner = await installedPanel(3020);
    const intruder = await seedUser(3021, "intruder3");
    await expect(
      engine.startInstall(testEnv, config, {
        userId: intruder.id,
        telegramChatId: 3021,
        accountRef: owner.account.id,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

    it("cannot cancel another user's job", async () => {
    const owner = await installedPanel(3030);
    const intruder = await seedUser(3031, "intruder4");
    const jobs = await jobsRepo.recentForUser(testEnv, owner.user.id, 1);
    const job = jobs[0]!;
    // Reset to a non-terminal state so cancellation is possible at all.
    await env.DB.prepare("UPDATE deployment_jobs SET status = 'pending' WHERE id = ?").bind(job.id).run();
    expect(await engine.cancelJob(testEnv, job.id, intruder.id)).toBe(false);
    expect((await jobsRepo.findById(testEnv, job.id))?.status).toBe("pending");
  });

  it("cannot delete another user's panel", async () => {
    const owner = await installedPanel(3040);
    const intruder = await seedUser(3041, "intruder5");
    await expect(
      engine.startDelete(testEnv, config, {
        userId: intruder.id,
        telegramChatId: 3041,
        panelId: owner.panel.id,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await panelsRepo.findById(testEnv, owner.panel.id))?.status).toBe("active");
  });

  it("cannot reveal another user's recovery key", async () => {
    const owner = await installedPanel(3050);
    const intruder = await seedUser(3051, "intruder6");
    const revealed = await manager.revealRecoveryKey(testEnv, intruder.id, owner.panel.id);
    expect(revealed.recoveryKey).toBeNull();

    // …while the owner can.
    const own = await manager.revealRecoveryKey(testEnv, owner.user.id, owner.panel.id);
    expect(own.recoveryKey).toBeTruthy();
  });

  it("scopes account listing to the owner", async () => {
    const owner = await installedPanel(3060);
    const other = await seedUser(3061, "other");
    expect(await accountsRepo.listForUser(testEnv, owner.user.id)).toHaveLength(1);
    expect(await accountsRepo.listForUser(testEnv, other.id)).toHaveLength(0);
  });
});

describe("role checks", () => {
  it("classifies roles correctly", () => {
    expect(usersRepo.isAdmin(["admin"])).toBe(true);
    expect(usersRepo.isAdmin(["support"])).toBe(false);
    expect(usersRepo.isStaff(["support"])).toBe(true);
    expect(usersRepo.isStaff(["user"])).toBe(false);
    expect(usersRepo.highestRole(["user", "admin", "support"])).toBe("admin");
    expect(usersRepo.highestRole([])).toBe("user");
  });

  it("promotes the bootstrap admin only once", async () => {
    const admin = await usersRepo.upsertFromTelegram(testEnv, { id: 7001, first_name: "Boss" });
    expect(await usersRepo.ensureBootstrapAdmin(testEnv, 7001)).toBe(true);
    expect(await usersRepo.countSuperAdmins(testEnv)).toBe(1);
    // A second call never grants a second super_admin.
    expect(await usersRepo.ensureBootstrapAdmin(testEnv, 7002)).toBe(false);
    expect(await usersRepo.rolesOf(testEnv, admin.id)).toContain("super_admin");
  });

  it("blocks and unblocks a user", async () => {
    const user = await seedUser(7100, "banned");
    await usersRepo.setBlocked(testEnv, user.id, true, "test");
    expect((await usersRepo.findById(testEnv, user.id))?.is_blocked).toBe(1);
    await usersRepo.setBlocked(testEnv, user.id, false, null);
    expect((await usersRepo.findById(testEnv, user.id))?.is_blocked).toBe(0);
  });
});
