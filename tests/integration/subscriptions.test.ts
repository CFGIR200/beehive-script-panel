/** Subscription plans, limits and expiry — all driven from the database. */

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../../src/config/env";
import * as subsRepo from "../../src/database/repositories/subscriptions";
import * as settingsRepo from "../../src/database/repositories/settings";
import * as panelsRepo from "../../src/database/repositories/panels";
import { assertCanBackup, assertCanInstall, assertCanUpdate, describeLimits, entitlementsFor } from "../../src/subscriptions/limits";
import { seedAccount, seedUser } from "../helpers";

const testEnv = env as unknown as Env;

describe("seeded plans", () => {
  it("ships the four documented plans", async () => {
    const plans = await subsRepo.listPlans(testEnv, false);
    expect(plans.map((plan) => plan.code).sort()).toEqual(["basic", "enterprise", "free", "pro"] as never);
  });

  it("free plan allows one panel and no backups", async () => {
    const plan = await subsRepo.findPlan(testEnv, "free");
    expect(plan?.max_panels).toBe(1);
    expect(plan?.allow_backup).toBe(0);
    expect(plan?.allow_update).toBe(1);
  });

  it("enterprise is unlimited (-1)", async () => {
    const plan = await subsRepo.findPlan(testEnv, "enterprise");
    expect(plan?.max_panels).toBe(-1);
  });
});

describe("entitlements", () => {
  it("falls back to the default plan when the user has no subscription", async () => {
    const user = await seedUser(6100, "nosub");
    const entitlements = await entitlementsFor(testEnv, user.id);
    expect(entitlements.plan.code).toBe("free");
    expect(entitlements.maxPanels).toBe(1);
    expect(entitlements.panelsUsed).toBe(0);
  });

  it("reflects a granted subscription", async () => {
    const user = await seedUser(6101, "pro");
    await subsRepo.grant(testEnv, { userId: user.id, planCode: "pro", durationDays: 30, grantedBy: null, note: "test" });
    const entitlements = await entitlementsFor(testEnv, user.id);
    expect(entitlements.plan.code).toBe("pro");
    expect(entitlements.canBackup).toBe(true);
    expect(entitlements.expiresAt).toBeGreaterThan(Date.now());
  });

  it("only ever keeps one active subscription per user", async () => {
    const user = await seedUser(6102, "multi");
    await subsRepo.grant(testEnv, { userId: user.id, planCode: "basic", durationDays: 30, grantedBy: null, note: null });
    await subsRepo.grant(testEnv, { userId: user.id, planCode: "pro", durationDays: 30, grantedBy: null, note: null });
    const active = await subsRepo.activeSubscription(testEnv, user.id);
    expect(active?.plan_code).toBe("pro");
    const history = await subsRepo.historyForUser(testEnv, user.id);
    expect(history.length).toBe(2);
  });

  it("expires a subscription whose date has passed", async () => {
    const user = await seedUser(6103, "expired");
    await subsRepo.grant(testEnv, { userId: user.id, planCode: "pro", durationDays: 1, grantedBy: null, note: null });
    await env.DB.prepare("UPDATE subscriptions SET expires_at = ? WHERE user_id = ?")
      .bind(Date.now() - 1000, user.id)
      .run();
    const changed = await subsRepo.expireDue(testEnv);
    expect(changed).toBeGreaterThanOrEqual(1);
    const entitlements = await entitlementsFor(testEnv, user.id);
    expect(entitlements.plan.code).toBe("free");
  });

  it("blocks installs when the admin disables them globally", async () => {
    const user = await seedUser(6104, "disabled");
    await settingsRepo.set(testEnv, "install_enabled", "0");
    const entitlements = await entitlementsFor(testEnv, user.id);
    expect(entitlements.canInstall).toBe(false);
    await expect(assertCanInstall(testEnv, user.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await settingsRepo.set(testEnv, "install_enabled", "1");
  });

  it("enforces update and backup flags", async () => {
    const user = await seedUser(6105, "flags");
    await subsRepo.grant(testEnv, { userId: user.id, planCode: "free", durationDays: 30, grantedBy: null, note: null });
    await assertCanUpdate(testEnv, user.id);
    await expect(assertCanBackup(testEnv, user.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("counts existing panels against the limit", async () => {
    const user = await seedUser(6106, "counter");
    const account = await seedAccount(user.id);
    for (let index = 0; index < 1; index += 1) {
      await panelsRepo.reserve(testEnv, {
        uid: `pn_test${index}`,
        userId: user.id,
        accountRef: account.id,
        cloudflareAccountId: account.cloudflare_account_id,
        workerName: `worker-${index}`,
        d1DatabaseName: `worker-${index}-db`,
        version: "3.1.13",
      });
    }
    await expect(assertCanInstall(testEnv, user.id)).rejects.toMatchObject({ code: "LIMIT_REACHED" });
  });

  it("renders Persian limit lines", async () => {
    const user = await seedUser(6107, "render");
    const lines = describeLimits(await entitlementsFor(testEnv, user.id));
    expect(lines.join(" ")).toContain("تعداد پنل");
  });
});

describe("system settings", () => {
  it("reads and writes values with defaults", async () => {
    expect(await settingsRepo.get(testEnv, "does_not_exist", "fallback")).toBe("fallback");
    await settingsRepo.set(testEnv, "custom_key", "custom_value", null);
    expect(await settingsRepo.get(testEnv, "custom_key")).toBe("custom_value");
    expect(await settingsRepo.getBool(testEnv, "install_enabled", true)).toBe(true);
    expect(await settingsRepo.getInt(testEnv, "max_global_concurrency", 6)).toBe(6);
  });

  it("caches idempotency responses until they expire", async () => {
    await settingsRepo.rememberIdempotency(testEnv, "key-1", "test", { ok: true }, 60_000);
    expect(await settingsRepo.lookupIdempotency(testEnv, "key-1")).toContain('"ok":true');
    await settingsRepo.rememberIdempotency(testEnv, "key-2", "test", { ok: true }, -1);
    expect(await settingsRepo.lookupIdempotency(testEnv, "key-2")).toBeNull();
  });
});
