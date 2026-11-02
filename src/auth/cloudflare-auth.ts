/**
 * Cloudflare credential lifecycle: verify → seal → store → load → revoke.
 *
 * This module is the only place where a plaintext Cloudflare API token exists in
 * memory, and it lives for the duration of a single call:
 *   • the token is never written to D1 unsealed,
 *   • it is never logged (CloudflareClient redacts, logger redacts),
 *   • it is never returned to the Telegram bot or the dashboard.
 */

import type { Env, PublicConfig } from "../config/env";
import { CloudflareClient } from "../cloudflare/client";
import { listAccounts, verifyToken, type CloudflareAccountInfo } from "../cloudflare/accounts";
import { probe, summarize } from "../cloudflare/permissions";
import { credentialContext, seal, unseal } from "../security/crypto";
import * as accountsRepo from "../database/repositories/accounts";
import { AppError, messages } from "../utils/errors";
import { createLogger } from "../utils/logger";
import { now } from "../utils/time";

export interface ConnectResult {
  account: accountsRepo.CloudflareAccount;
  accountInfo: CloudflareAccountInfo;
  permissions: Awaited<ReturnType<typeof probe>>;
}

/**
 * Verifies a token, seals it, stores the connection and returns the account row.
 * Re-connecting the same Cloudflare account replaces the stored credential.
 */
export async function connectAccount(
  env: Env,
  config: PublicConfig,
  input: { userId: number; token: string; cloudflareAccountId: string; traceId: string },
): Promise<ConnectResult> {
  const logger = createLogger({ traceId: input.traceId, scope: "cloudflare-auth" });
  const client = new CloudflareClient(input.token, { traceId: input.traceId });

  logger.info("verifying token");
  const verified = await verifyToken(client);

  const available = await listAccounts(client);
  const accountInfo = available.find((account) => account.id.toLowerCase() === input.cloudflareAccountId.toLowerCase());
  if (!accountInfo) {
    throw new AppError("FORBIDDEN", "این حساب در دسترس توکن ارسال‌شده نیست.", {
      detail: `account ${input.cloudflareAccountId} not visible to token`,
    });
  }

  const permissions = await probe(client, accountInfo.id);

  // Existing row (reconnect) or a fresh connection.
  const existing = await accountsRepo.findByCloudflareId(env, input.userId, accountInfo.id);
  let account: accountsRepo.CloudflareAccount;
  if (existing) {
    await accountsRepo.updateAccountConnection(env, existing.id, {
      tokenVerifiedAt: now(),
      tokenExpiresOn: verified.expiresOn ?? null,
      accountName: accountInfo.name,
      permissionsVerified: permissions.ok,
      permissionsDetail: summarize(permissions),
    });
    account = { ...existing, account_name: accountInfo.name, permissions_verified: permissions.ok ? 1 : 0 };
  } else {
    account = await accountsRepo.insertAccount(env, {
      userId: input.userId,
      cloudflareAccountId: accountInfo.id,
      accountName: accountInfo.name,
      tokenVerifiedAt: now(),
      tokenExpiresOn: verified.expiresOn ?? null,
      tokenIdSuffix: verified.id ? verified.id.slice(-6) : null,
      permissionsVerified: permissions.ok,
      permissionsDetail: summarize(permissions),
    });
  }

  const sealed = await seal(
    input.token,
    credentialContext(input.userId, account.id, "cloudflare_api_token"),
    env.CREDENTIAL_ENCRYPTION_KEY,
  );
  await accountsRepo.saveCredential(env, {
    userId: input.userId,
    accountRef: account.id,
    purpose: "cloudflare_api_token",
    ciphertext: sealed.ciphertext,
    iv: sealed.iv,
    keyVersion: sealed.keyVersion,
  });

  logger.info("account connected", { accountRef: account.id, permissionsOk: permissions.ok });
  return { account, accountInfo, permissions };
}

export interface LoadedConnection {
  client: CloudflareClient;
  account: accountsRepo.CloudflareAccount;
  token: string;
}

/**
 * Loads and unseals the credential for a tenant-scoped account.
 * The `userId` predicate is enforced in SQL as well as here (defence in depth).
 */
export async function loadConnection(
  env: Env,
  config: PublicConfig,
  userId: number,
  accountRef: number,
  traceId: string,
): Promise<LoadedConnection> {
  const account = await accountsRepo.findForUser(env, userId, accountRef);
  if (!account) throw new AppError("NOT_FOUND", messages.notFound, { detail: "account not found for tenant" });

  const credential = await accountsRepo.loadCredential(env, userId, account.id);
  if (!credential || !credential.ciphertext) {
    throw new AppError("UNAUTHORIZED", "توکن این حساب در دسترس نیست؛ لطفاً دوباره متصل کنید.", {
      detail: "credential revoked or missing",
    });
  }

  let token: string;
  try {
    token = await unseal(
      { ciphertext: credential.ciphertext, iv: credential.iv, keyVersion: credential.key_version },
      credentialContext(userId, account.id, "cloudflare_api_token"),
      env.CREDENTIAL_ENCRYPTION_KEY,
      env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS,
    );
  } catch (error) {
    throw new AppError("UNAUTHORIZED", messages.cfUnauthorized, {
      detail: `unseal failed: ${(error as Error).message}`,
      cause: error,
    });
  }

  if (!token) throw new AppError("UNAUTHORIZED", messages.cfUnauthorized, { detail: "empty token after unseal" });

  return { client: new CloudflareClient(token, { traceId }), account, token };
}

/**
 * Revokes a connection: wipes the ciphertext and marks the account revoked.
 * Panels already deployed keep running — they are independent Workers on the
 * customer's account — but the bot can no longer manage them until reconnect.
 */
export async function disconnectAccount(env: Env, userId: number, accountRef: number): Promise<void> {
  const account = await accountsRepo.findForUser(env, userId, accountRef);
  if (!account) throw new AppError("NOT_FOUND", messages.notFound);
  await accountsRepo.revokeCredentials(env, account.id, userId);
  await accountsRepo.markRevoked(env, account.id, userId, "disconnected_by_owner");
}
