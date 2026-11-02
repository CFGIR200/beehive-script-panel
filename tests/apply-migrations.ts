import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll } from "vitest";

// Applies every migration in ./migrations to the test D1 database once per suite.
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
