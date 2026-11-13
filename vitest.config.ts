import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";
import path from "node:path";

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, "migrations"));
  return {
    test: {
      include: ["tests/**/*.test.ts"],
      setupFiles: ["./tests/apply-migrations.ts"],
      poolOptions: {
        workers: {
          singleWorker: true,
          main: "./src/index.ts",
          wrangler: { configPath: "./wrangler.toml" },
          miniflare: {
            bindings: {
              TEST_MIGRATIONS: migrations,
              ENVIRONMENT: "test",
              PUBLIC_BASE_URL: "https://beehive.test",
              BOT_USERNAME: "beehive_test_bot",
              BOOTSTRAP_ADMIN_TELEGRAM_ID: "1",
              PANEL_ARTIFACT_KEY: "panel/beehive-panel-3.1.13.js",
              PANEL_ARTIFACT_VERSION: "3.1.13",
              PANEL_ARTIFACT_SHA256: "0e164a0a8f985e9024ebd1a7de059dedd0915e132638e93513290687eb963cd4",
              PANEL_COMPATIBILITY_DATE: "2025-03-10",
              PANEL_CRON: "0 * * * *",
              JOB_SLICE_MS: "6000",
              PANEL_VERIFY_ATTEMPTS: "2",
              PANEL_VERIFY_INTERVAL_MS: "25",
              SUPPORT_CONTACT: "@support",
              TELEGRAM_BOT_TOKEN: "123456:TESTTOKEN_abcdefghijklmnopqrstuvwxyz",
              TELEGRAM_WEBHOOK_SECRET: "test_webhook_secret_value_123456",
              CREDENTIAL_ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
              SESSION_SIGNING_KEY: "test-session-signing-key-value-0123456789",
              FEATURE_SELF_SERVE_INSTALL: "true",
              FEATURE_PAYMENTS: "false",
            },
          },
        },
      },
    },
  };
});
