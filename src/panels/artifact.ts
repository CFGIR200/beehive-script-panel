/**
 * Approved panel artifact store.
 *
 * The Bee.Hive bundle is never embedded in this Worker: it lives in R2 (or is
 * supplied by an operator-injected KV entry) and is fetched at deploy time.
 * The SHA-256 registered in `panel_versions` is the integrity anchor — a bundle
 * whose digest does not match is never uploaded to a customer account.
 */

import type { Env } from "../config/env";
import type { PublicConfig } from "../config/env";
import { AppError, messages } from "../utils/errors";
import { sha256Hex } from "../utils/ids";

export interface PanelArtifact {
  version: string;
  source: string;
  sha256: string;
  key: string;
  bytes: number;
}

export interface ArtifactStore {
  load(version: string, expectedSha256: string, key: string): Promise<PanelArtifact>;
}

export function createArtifactStore(env: Env, config: PublicConfig): ArtifactStore {
  return {
    async load(version: string, expectedSha256: string, key: string): Promise<PanelArtifact> {
      if (!env.ARTIFACTS) {
        throw new AppError(
          "ARTIFACT_MISSING",
          "مخزن فایل پنل (R2) تنظیم نشده است؛ نصب پنل در دسترس نیست.",
          { detail: "ARTIFACTS binding missing" },
        );
      }
      const object = await env.ARTIFACTS.get(key);
      if (!object) {
        throw new AppError("ARTIFACT_MISSING", messages.artifactMissing, { detail: `R2 object not found: ${key}` });
      }
      const buffer = await object.arrayBuffer();
      const digest = await sha256Hex(buffer);

      const expected = (expectedSha256 || config.artifactSha256).toLowerCase();
      if (expected && digest !== expected) {
        throw new AppError("ARTIFACT_INTEGRITY", messages.artifactIntegrity, {
          detail: `sha256 mismatch for ${key}: expected ${expected.slice(0, 12)}… got ${digest.slice(0, 12)}…`,
        });
      }

      const source = new TextDecoder().decode(buffer);
      if (source.length < 1024) {
        throw new AppError("ARTIFACT_INTEGRITY", messages.artifactIntegrity, {
          detail: `artifact too small (${source.length} bytes)`,
        });
      }

      return { version, source, sha256: digest, key, bytes: buffer.byteLength };
    },
  };
}

/** Formats a byte count for Persian UI. */
export function humanBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return "—";
  const units = ["بایت", "کیلوبایت", "مگابایت", "گیگابایت"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}
