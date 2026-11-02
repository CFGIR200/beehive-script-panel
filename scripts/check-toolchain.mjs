#!/usr/bin/env node
/**
 * Toolchain guard — runs automatically before `npm test` (`pretest`).
 *
 * Why this exists: `npm audit fix --force` upgrades
 * @cloudflare/vitest-pool-workers to 0.23.x, a package that was RENAMED
 * (@cloudflare/vitest-plugin), requires vitest ^4, and no longer exports the
 * `./config` subpath. The result is a confusing esbuild error
 * "Missing ./config specifier" and a dead test suite.
 *
 * The versions below are the ones this release was verified against
 * (tsc clean, 94/94 tests, wrangler dry-run 374 KiB). Do not float them.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = async (p) => JSON.parse(await readFile(path.join(root, p), "utf8"));

const pkg = await read("package.json");
const expected = pkg.devDependencies ?? {};
const problems = [];

for (const [name, want] of Object.entries(expected)) {
  let installed;
  try {
    installed = (await read(`node_modules/${name}/package.json`)).version;
  } catch {
    problems.push(`${name}: not installed (expected ${want})`);
    continue;
  }
  if (installed !== want) problems.push(`${name}: installed ${installed}, expected ${want}`);
}

// The subpath the test config depends on.
try {
  const pool = await read("node_modules/@cloudflare/vitest-pool-workers/package.json");
  const exportsMap = pool.exports ?? {};
  if (!Object.keys(exportsMap).some((key) => key.startsWith("./config"))) {
    problems.push(
      `@cloudflare/vitest-pool-workers ${pool.version}: package no longer exports "./config" (renamed package?)`,
    );
  }
} catch {
  /* already reported above */
}

if (problems.length === 0) process.exit(0);

console.error("");
console.error("✘ Dependency toolchain was modified (most likely by `npm audit fix --force`).");
for (const problem of problems) console.error(`   • ${problem}`);
console.error("");
console.error("This project has ZERO npm runtime dependencies: every package above is");
console.error("dev-only tooling (tests, type-check, deploy). Audit advisories in that tree");
console.error("do not ship inside the Worker. Do NOT run `npm audit fix --force` here.");
console.error("");
console.error("Fix (inside the project folder):");
console.error("  rmdir /s /q node_modules        :: Windows PowerShell: Remove-Item -Recurse -Force node_modules");
console.error("  del package-lock.json           :: Windows PowerShell: Remove-Item package-lock.json");
console.error("  npm install --no-audit --no-fund");
console.error("");
console.error("To see only what ships to production:  npm audit --omit=dev   → 0 vulnerabilities");
console.error("");
process.exit(1);
