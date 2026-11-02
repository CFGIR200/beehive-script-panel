/** Cloudflare account connections and their sealed credentials. */

import type { Env } from "../../config/env";
import { all, one, run, scalar, type Pagination } from "../db";
import { now } from "../../utils/time";
import { AppError, messages } from "../../utils/errors";

export interface CloudflareAccount {
  id: number;
  user_id: number;
  cloudflare_account_id: string;
  account_name: string;
  token_verified_at: number;
  token_status: string;
  token_expires_on: string | null;
  token_id_suffix: string | null;
  permissions_verified: number;
  permissions_detail: string | null;
  workers_subdomain: string | null;
  created_at: number;
  updated_at: number;
  last_error: string | null;
}

export interface CredentialRow {
  id: number;
  user_id: number;
  account_ref: number;
  purpose: string;
  ciphertext: string;
  iv: string;
  key_version: number;
  created_at: number;
  rotated_at: number | null;
  revoked_at: number | null;
}

export async function insertAccount(
  env: Env,
  input: {
    userId: number;
    cloudflareAccountId: string;
    accountName: string;
    tokenVerifiedAt: number;
    tokenExpiresOn: string | null;
    tokenIdSuffix: string | null;
    permissionsVerified: boolean;
    permissionsDetail: string | null;
  },
): Promise<CloudflareAccount> {
  const ts = now();
  await run(
    env,
    `INSERT INTO cloudflare_accounts
       (user_id, cloudflare_account_id, account_name, token_verified_at, token_status, token_expires_on,
        token_id_suffix, permissions_verified, permissions_detail, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
    input.userId,
    input.cloudflareAccountId,
    input.accountName,
    input.tokenVerifiedAt,
    input.tokenExpiresOn,
    input.tokenIdSuffix,
    input.permissionsVerified ? 1 : 0,
    input.permissionsDetail,
    ts,
    ts,
  );
  const account = await one<CloudflareAccount>(
    env,
    "SELECT * FROM cloudflare_accounts WHERE user_id = ? AND cloudflare_account_id = ?",
    input.userId,
    input.cloudflareAccountId,
  );
  if (!account) throw new AppError("INTERNAL", messages.internal, { detail: "account insert returned no row" });
  return account;
}

export async function updateAccountConnection(
  env: Env,
  accountRef: number,
  input: {
    tokenVerifiedAt: number;
    tokenExpiresOn: string | null;
    accountName: string;
    permissionsVerified: boolean;
    permissionsDetail: string | null;
  },
): Promise<void> {
  await run(
    env,
    `UPDATE cloudflare_accounts
        SET token_verified_at = ?, token_expires_on = ?, account_name = ?, token_status = 'active',
            permissions_verified = ?, permissions_detail = ?, last_error = NULL, updated_at = ?
      WHERE id = ?`,
    input.tokenVerifiedAt,
    input.tokenExpiresOn,
    input.accountName,
    input.permissionsVerified ? 1 : 0,
    input.permissionsDetail,
    now(),
    accountRef,
  );
}

export async function listForUser(env: Env, userId: number): Promise<CloudflareAccount[]> {
  return all<CloudflareAccount>(
    env,
    "SELECT * FROM cloudflare_accounts WHERE user_id = ? AND token_status != 'revoked' ORDER BY created_at ASC",
    userId,
  );
}

export async function listAll(env: Env, page: Pagination): Promise<CloudflareAccount[]> {
  return all<CloudflareAccount>(
    env,
    "SELECT * FROM cloudflare_accounts ORDER BY created_at DESC LIMIT ? OFFSET ?",
    page.limit,
    page.offset,
  );
}

/** Tenant-scoped read: the user_id predicate is mandatory. */
export async function findForUser(env: Env, userId: number, accountRef: number): Promise<CloudflareAccount | null> {
  return one<CloudflareAccount>(
    env,
    "SELECT * FROM cloudflare_accounts WHERE id = ? AND user_id = ? AND token_status != 'revoked'",
    accountRef,
    userId,
  );
}

export async function findByCloudflareId(
  env: Env,
  userId: number,
  cloudflareAccountId: string,
): Promise<CloudflareAccount | null> {
  return one<CloudflareAccount>(
    env,
    "SELECT * FROM cloudflare_accounts WHERE user_id = ? AND cloudflare_account_id = ?",
    userId,
    cloudflareAccountId,
  );
}

export async function countForUser(env: Env, userId: number): Promise<number> {
  return scalar(
    env,
    "SELECT COUNT(*) FROM cloudflare_accounts WHERE user_id = ? AND token_status != 'revoked'",
    userId,
  );
}

export async function setSubdomain(env: Env, accountRef: number, subdomain: string): Promise<void> {
  await run(env, "UPDATE cloudflare_accounts SET workers_subdomain = ?, updated_at = ? WHERE id = ?", subdomain, now(), accountRef);
}

export async function recordError(env: Env, accountRef: number, error: string | null): Promise<void> {
  await run(env, "UPDATE cloudflare_accounts SET last_error = ?, updated_at = ? WHERE id = ?", error, now(), accountRef);
}

// ---------------------------------------------------------------------------
// Sealed credentials
// ---------------------------------------------------------------------------

export async function saveCredential(env: Env, input: {
  userId: number;
  accountRef: number;
  purpose: string;
  ciphertext: string;
  iv: string;
  keyVersion: number;
}): Promise<void> {
  await run(
    env,
    `INSERT INTO encrypted_credentials (user_id, account_ref, purpose, ciphertext, iv, key_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (account_ref, purpose) DO UPDATE SET
       ciphertext = excluded.ciphertext,
       iv = excluded.iv,
       key_version = excluded.key_version,
       rotated_at = ?,
       revoked_at = NULL`,
    input.userId,
    input.accountRef,
    input.purpose,
    input.ciphertext,
    input.iv,
    input.keyVersion,
    now(),
    now(),
  );
}

export async function loadCredential(
  env: Env,
  userId: number,
  accountRef: number,
  purpose = "cloudflare_api_token",
): Promise<CredentialRow | null> {
  return one<CredentialRow>(
    env,
    `SELECT * FROM encrypted_credentials
      WHERE account_ref = ? AND user_id = ? AND purpose = ? AND revoked_at IS NULL`,
    accountRef,
    userId,
    purpose,
  );
}

export async function revokeCredentials(env: Env, accountRef: number, userId: number): Promise<void> {
  await run(
    env,
    "UPDATE encrypted_credentials SET revoked_at = ?, ciphertext = '', iv = '' WHERE account_ref = ? AND user_id = ?",
    now(),
    accountRef,
    userId,
  );
}

export async function markRevoked(env: Env, accountRef: number, userId: number, reason: string): Promise<void> {
  await run(
    env,
    `UPDATE cloudflare_accounts SET token_status = 'revoked', last_error = ?, updated_at = ?
      WHERE id = ? AND user_id = ?`,
    reason,
    now(),
    accountRef,
    userId,
  );
}
