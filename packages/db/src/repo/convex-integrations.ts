import {
  type ConvexDeliveryFinish,
  claimDueConvexDeliveries,
  finishConvexDelivery,
} from "./convex-deliveries";
import {
  type ConvexPreparationFailure,
  deferConvexPreparationFailure,
} from "./convex-preparation-backoff";
import { type DeliveryRetentionInput, pruneConvexDeliveries } from "./delivery-retention";
import { listPushInstallations, listPushInstallationsByIds } from "./push-installation-list";
import type { EnvScope } from "./scope";
import { assertMintedScope } from "./scope";

export interface ConvexInstallationWrite {
  installationId: string;
  callbackUrl: string;
  secretCiphertext: string;
  secretKeyVersion: string;
  secretFingerprint: string;
  now: string;
}

export interface ConvexInstallationRow {
  installationId: string;
  appId: string;
  environmentId: string;
  callbackUrl: string;
  secretCiphertext: string;
  secretKeyVersion: string;
  secretFingerprint: string;
  lastRotationId: string | null;
  lastRotationFingerprint: string | null;
  status: "active" | "revoked";
  lastDeliveredVersion: number | null;
  lastDeliveredAt: string | null;
  latestDeliveryErrorJson: string | null;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
}

export interface ConfigWebhookDeliveryRow {
  deliveryId: string;
  installationId: string;
  callbackUrl: string;
  secretCiphertext: string;
  secretKeyVersion: string;
  environmentVersion: number;
  bodyJson: string;
  attemptCount: number;
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: This cohesive D1 adapter keeps all Convex integration SQL behind one scoped repository seam.
export function makeConvexIntegrationRepo(d1: D1Database) {
  return {
    async environmentVersion(scope: EnvScope): Promise<number> {
      assertMintedScope(scope);
      const row = await d1
        .prepare(
          "SELECT config_version AS configVersion FROM environments WHERE app_id = ? AND id = ?",
        )
        .bind(scope.appId, scope.environmentId)
        .first<{ configVersion: number }>();
      if (!row) throw new Error("convex integrations: Environment not found in scope");
      return row.configVersion;
    },

    async getInstallation(
      scope: EnvScope,
      installationId: string,
    ): Promise<ConvexInstallationRow | null> {
      assertMintedScope(scope);
      return d1
        .prepare(
          `${INSTALLATION_SELECT} WHERE app_id = ? AND environment_id = ? AND installation_id = ?`,
        )
        .bind(scope.appId, scope.environmentId, installationId)
        .first<ConvexInstallationRow>();
    },

    async listInstallations(scope: EnvScope, options?: { limit?: number }) {
      assertMintedScope(scope);
      return listPushInstallations<ConvexInstallationRow>(
        d1,
        scope,
        INSTALLATION_SELECT,
        "config_webhook_deliveries",
        options,
      );
    },

    listInstallationsByIds(scope: EnvScope, installationIds: readonly string[]) {
      assertMintedScope(scope);
      return listPushInstallationsByIds<ConvexInstallationRow>(
        d1,
        scope,
        INSTALLATION_SELECT,
        installationIds,
      );
    },

    async createInstallation(
      scope: EnvScope,
      input: ConvexInstallationWrite,
    ): Promise<ConvexInstallationRow> {
      assertMintedScope(scope);
      await d1
        .prepare(`INSERT OR IGNORE INTO convex_installations (
          installation_id, app_id, environment_id, callback_url, secret_ciphertext,
          secret_key_version, secret_fingerprint, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`)
        .bind(
          input.installationId,
          scope.appId,
          scope.environmentId,
          input.callbackUrl,
          input.secretCiphertext,
          input.secretKeyVersion,
          input.secretFingerprint,
          input.now,
          input.now,
        )
        .run();
      const row = await this.getInstallation(scope, input.installationId);
      if (!row) throw new Error("convex integrations: installation insert did not produce a row");
      return row;
    },

    async rotateSecret(
      scope: EnvScope,
      installationId: string,
      input: Pick<
        ConvexInstallationWrite,
        "secretCiphertext" | "secretKeyVersion" | "secretFingerprint" | "now"
      > & { rotationId: string },
    ): Promise<ConvexInstallationRow | null> {
      assertMintedScope(scope);
      await d1
        .prepare(`UPDATE convex_installations SET
          secret_ciphertext = ?, secret_key_version = ?, secret_fingerprint = ?,
          last_rotation_id = ?, last_rotation_fingerprint = ?, updated_at = ?, preparation_retry_at = NULL
          WHERE app_id = ? AND environment_id = ? AND installation_id = ? AND status = 'active'`)
        .bind(
          input.secretCiphertext,
          input.secretKeyVersion,
          input.secretFingerprint,
          input.rotationId,
          input.secretFingerprint,
          input.now,
          scope.appId,
          scope.environmentId,
          installationId,
        )
        .run();
      return this.getInstallation(scope, installationId);
    },

    async revokeInstallation(scope: EnvScope, installationId: string, now: string): Promise<void> {
      assertMintedScope(scope);
      await d1.batch([
        d1
          .prepare(`UPDATE convex_installations SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?), updated_at = ?
          WHERE app_id = ? AND environment_id = ? AND installation_id = ?`)
          .bind(now, now, scope.appId, scope.environmentId, installationId),
        d1
          .prepare(`UPDATE config_webhook_deliveries SET state = 'suppressed', lease_owner = NULL, lease_expires_at = NULL
          WHERE app_id = ? AND environment_id = ? AND installation_id = ? AND state IN ('pending', 'leased')`)
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
        FROM config_webhook_deliveries WHERE app_id = ? AND environment_id = ? AND installation_id = ?`)
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
    ): Promise<ConfigWebhookDeliveryRow[]> {
      return claimDueConvexDeliveries(d1, now, leaseOwner, leaseExpiresAt, limit);
    },

    async finishDelivery(
      deliveryId: string,
      leaseOwner: string,
      input: ConvexDeliveryFinish,
    ): Promise<void> {
      await finishConvexDelivery(d1, deliveryId, leaseOwner, input);
    },

    deferPreparationFailure(
      installationId: string,
      leaseOwner: string,
      input: ConvexPreparationFailure,
    ) {
      return deferConvexPreparationFailure(d1, installationId, leaseOwner, input);
    },

    pruneDeliveries(input: DeliveryRetentionInput) {
      return pruneConvexDeliveries(d1, input);
    },
  };
}

const INSTALLATION_SELECT = `SELECT
  installation_id AS installationId, app_id AS appId, environment_id AS environmentId,
  callback_url AS callbackUrl, secret_ciphertext AS secretCiphertext,
  secret_key_version AS secretKeyVersion, secret_fingerprint AS secretFingerprint,
  last_rotation_id AS lastRotationId, last_rotation_fingerprint AS lastRotationFingerprint,
  status, last_delivered_version AS lastDeliveredVersion, last_delivered_at AS lastDeliveredAt,
  latest_delivery_error_json AS latestDeliveryErrorJson, created_at AS createdAt,
  updated_at AS updatedAt, revoked_at AS revokedAt FROM convex_installations`;
