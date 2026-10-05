import {
  claimDueCloudflareDeliveries,
  type CloudflareDeliveryFinish,
  finishCloudflareDelivery,
  retryTerminalCloudflareDelivery,
} from "./cloudflare-deliveries";
import { listPushInstallations, listPushInstallationsByIds } from "./push-installation-list";
import type { EnvScope } from "./scope";
import { assertMintedScope } from "./scope";

export interface CloudflareInstallationWrite {
  installationId: string;
  endpoint: string;
  secretCiphertext: string;
  secretKeyVersion: string;
  secretFingerprint: string;
  now: string;
}

export interface CloudflareInstallationRow {
  installationId: string;
  appId: string;
  environmentId: string;
  endpoint: string;
  secretCiphertext: string;
  secretKeyVersion: string;
  secretFingerprint: string;
  status: "active" | "revoked";
  lastAppliedVersion: number | null;
  lastAppliedAt: string | null;
  latestDeliveryErrorJson: string | null;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
}

export interface CloudflareDeliveryRow {
  deliveryId: string;
  installationId: string;
  appId: string;
  environmentId: string;
  endpoint: string;
  secretCiphertext: string;
  secretKeyVersion: string;
  environmentVersion: number;
  attemptCount: number;
  lastAppliedVersion: number | null;
  registeredAt: string;
}

export function makeCloudflareIntegrationRepo(d1: D1Database) {
  return {
    async environmentVersion(scope: EnvScope): Promise<number> {
      assertMintedScope(scope);
      const row = await d1
        .prepare(
          "SELECT config_version AS configVersion FROM environments WHERE app_id = ? AND id = ?",
        )
        .bind(scope.appId, scope.environmentId)
        .first<{ configVersion: number }>();
      if (!row) throw new Error("cloudflare integrations: Environment not found in scope");
      return row.configVersion;
    },

    async getInstallation(
      scope: EnvScope,
      installationId: string,
    ): Promise<CloudflareInstallationRow | null> {
      assertMintedScope(scope);
      return d1
        .prepare(`${INSTALLATION_SELECT}
        WHERE app_id = ? AND environment_id = ? AND installation_id = ?`)
        .bind(scope.appId, scope.environmentId, installationId)
        .first<CloudflareInstallationRow>();
    },

    async listInstallations(scope: EnvScope, options?: { limit?: number }) {
      assertMintedScope(scope);
      return listPushInstallations<CloudflareInstallationRow>(
        d1,
        scope,
        INSTALLATION_SELECT,
        "cloudflare_config_deliveries",
        options,
      );
    },

    listInstallationsByIds: (scope: EnvScope, installationIds: readonly string[]) =>
      listCloudflareInstallationsByIds(d1, scope, installationIds),

    async createInstallation(
      scope: EnvScope,
      input: CloudflareInstallationWrite,
    ): Promise<CloudflareInstallationRow> {
      assertMintedScope(scope);
      await d1.batch([
        d1
          .prepare(`INSERT OR IGNORE INTO cloudflare_installations (
          installation_id, app_id, environment_id, endpoint, secret_ciphertext,
          secret_key_version, secret_fingerprint, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`)
          .bind(
            input.installationId,
            scope.appId,
            scope.environmentId,
            input.endpoint,
            input.secretCiphertext,
            input.secretKeyVersion,
            input.secretFingerprint,
            input.now,
            input.now,
          ),
        d1
          .prepare(`INSERT OR IGNORE INTO cloudflare_config_deliveries (
          delivery_id, installation_id, app_id, environment_id, environment_version,
          state, attempt_count, next_attempt_at, created_at
        ) SELECT ?, ?, app_id, id, config_version, 'pending', 0, ?, ?
          FROM environments WHERE app_id = ? AND id = ?`)
          .bind(
            crypto.randomUUID(),
            input.installationId,
            input.now,
            input.now,
            scope.appId,
            scope.environmentId,
          ),
      ]);
      const row = await this.getInstallation(scope, input.installationId);
      if (!row)
        throw new Error("cloudflare integrations: installation insert did not produce a row");
      return row;
    },

    retryTerminalDelivery: (scope: EnvScope, installationId: string, now: string) =>
      retryTerminalCloudflareDelivery(d1, scope, installationId, now),

    async revokeInstallation(scope: EnvScope, installationId: string, now: string): Promise<void> {
      assertMintedScope(scope);
      await d1.batch([
        d1
          .prepare(`UPDATE cloudflare_installations SET status = 'revoked',
          revoked_at = COALESCE(revoked_at, ?), updated_at = ?
          WHERE app_id = ? AND environment_id = ? AND installation_id = ?`)
          .bind(now, now, scope.appId, scope.environmentId, installationId),
        d1
          .prepare(`UPDATE cloudflare_config_deliveries SET state = 'suppressed',
          lease_owner = NULL, lease_expires_at = NULL
          WHERE app_id = ? AND environment_id = ? AND installation_id = ?
          AND state IN ('pending', 'leased')`)
          .bind(scope.appId, scope.environmentId, installationId),
      ]);
    },

    async deliveryHealth(scope: EnvScope, installationId: string, nowMs: number) {
      assertMintedScope(scope);
      const row = await d1
        .prepare(`SELECT
        SUM(CASE WHEN state IN ('pending', 'leased') THEN 1 ELSE 0 END) AS pendingCount,
        SUM(CASE WHEN state = 'terminal' THEN 1 ELSE 0 END) AS terminalCount,
        MIN(CASE WHEN state IN ('pending', 'leased') THEN created_at END) AS oldestPendingAt
        FROM cloudflare_config_deliveries
        WHERE app_id = ? AND environment_id = ? AND installation_id = ?`)
        .bind(scope.appId, scope.environmentId, installationId)
        .first<{
          pendingCount: number | null;
          terminalCount: number | null;
          oldestPendingAt: string | null;
        }>();
      const oldestMs = row?.oldestPendingAt ? Date.parse(row.oldestPendingAt) : Number.NaN;
      return {
        pendingCount: row?.pendingCount ?? 0,
        terminalCount: row?.terminalCount ?? 0,
        oldestPendingAgeMs: Number.isFinite(oldestMs) ? Math.max(0, nowMs - oldestMs) : null,
      };
    },

    async claimDueDeliveries(
      now: string,
      leaseOwner: string,
      leaseExpiresAt: string,
      limit: number,
    ): Promise<CloudflareDeliveryRow[]> {
      return claimDueCloudflareDeliveries(d1, now, leaseOwner, leaseExpiresAt, limit);
    },

    async finishDelivery(
      deliveryId: string,
      leaseOwner: string,
      input: CloudflareDeliveryFinish,
    ): Promise<void> {
      await finishCloudflareDelivery(d1, deliveryId, leaseOwner, input);
    },
  };
}

function listCloudflareInstallationsByIds(
  d1: D1Database,
  scope: EnvScope,
  installationIds: readonly string[],
) {
  assertMintedScope(scope);
  return listPushInstallationsByIds<CloudflareInstallationRow>(
    d1,
    scope,
    INSTALLATION_SELECT,
    installationIds,
  );
}

const INSTALLATION_SELECT = `SELECT installation_id AS installationId, app_id AS appId,
  environment_id AS environmentId, endpoint, secret_ciphertext AS secretCiphertext,
  secret_key_version AS secretKeyVersion, secret_fingerprint AS secretFingerprint,
  status, last_applied_version AS lastAppliedVersion, last_applied_at AS lastAppliedAt,
  latest_delivery_error_json AS latestDeliveryErrorJson, created_at AS createdAt,
  updated_at AS updatedAt, revoked_at AS revokedAt FROM cloudflare_installations`;
