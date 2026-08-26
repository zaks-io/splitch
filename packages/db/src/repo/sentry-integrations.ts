import type { EnvScope } from "./scope";
import { assertMintedScope } from "./scope";

/**
 * Sentry change-tracking installations.
 *
 * Unlike the Convex integration there is no delivery outbox: Sentry's
 * `change_id` is an idempotency token by contract, so redelivering a batch after
 * a failed attempt is safe, and `last_delivered_seq` over the monotonic
 * `flag_change_events.seq` is a sufficient cursor. Retry state therefore lives
 * on the installation row.
 */

export interface SentryInstallationWrite {
  installationId: string;
  webhookUrl: string;
  secretCiphertext: string;
  secretKeyVersion: string;
  secretFingerprint: string;
  now: string;
}

export interface SentryInstallationRow {
  installationId: string;
  appId: string;
  environmentId: string;
  webhookUrl: string;
  secretCiphertext: string;
  secretKeyVersion: string;
  secretFingerprint: string;
  lastRotationId: string | null;
  lastRotationFingerprint: string | null;
  status: "active" | "revoked";
  lastDeliveredSeq: number | null;
  lastDeliveredAt: string | null;
  attemptCount: number;
  nextAttemptAt: string;
  latestDeliveryErrorJson: string | null;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
}

export function makeSentryIntegrationRepo(d1: D1Database) {
  return {
    async getInstallation(
      scope: EnvScope,
      installationId: string,
    ): Promise<SentryInstallationRow | null> {
      assertMintedScope(scope);
      return d1
        .prepare(
          `${INSTALLATION_SELECT} WHERE app_id = ? AND environment_id = ? AND installation_id = ?`,
        )
        .bind(scope.appId, scope.environmentId, installationId)
        .first<SentryInstallationRow>();
    },

    /**
     * Every installation this Environment has ever had, newest first. Revoked
     * rows are included: they are the record of where Flag changes used to be
     * sent, and hiding them would make a revoked Sentry org indistinguishable
     * from one that was never wired up.
     */
    async listInstallations(scope: EnvScope): Promise<SentryInstallationRow[]> {
      assertMintedScope(scope);
      const rows = await d1
        .prepare(
          `${INSTALLATION_SELECT} WHERE app_id = ? AND environment_id = ? ORDER BY created_at DESC`,
        )
        .bind(scope.appId, scope.environmentId)
        .all<SentryInstallationRow>();
      return rows.results;
    },

    /**
     * Fails loud on a duplicate rather than INSERT OR IGNORE: a second
     * installation against an Environment that already has one is a
     * misconfiguration the caller must see, not a silent no-op that would leave
     * them believing a different Sentry org was wired up.
     */
    async createInstallation(
      scope: EnvScope,
      input: SentryInstallationWrite,
    ): Promise<SentryInstallationRow> {
      assertMintedScope(scope);
      await d1
        .prepare(`INSERT INTO sentry_installations (
          installation_id, app_id, environment_id, webhook_url, secret_ciphertext,
          secret_key_version, secret_fingerprint, status, next_attempt_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`)
        .bind(
          input.installationId,
          scope.appId,
          scope.environmentId,
          input.webhookUrl,
          input.secretCiphertext,
          input.secretKeyVersion,
          input.secretFingerprint,
          input.now,
          input.now,
          input.now,
        )
        .run();
      const row = await this.getInstallation(scope, input.installationId);
      if (!row) throw new Error("sentry integrations: installation insert did not produce a row");
      return row;
    },

    async rotateSecret(
      scope: EnvScope,
      installationId: string,
      input: Pick<
        SentryInstallationWrite,
        "secretCiphertext" | "secretKeyVersion" | "secretFingerprint" | "now"
      > & { rotationId: string },
    ): Promise<SentryInstallationRow | null> {
      assertMintedScope(scope);
      await d1
        .prepare(`UPDATE sentry_installations SET
          secret_ciphertext = ?, secret_key_version = ?, secret_fingerprint = ?,
          last_rotation_id = ?, last_rotation_fingerprint = ?, updated_at = ?
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
      await d1
        .prepare(`UPDATE sentry_installations SET status = 'revoked',
          revoked_at = COALESCE(revoked_at, ?), updated_at = ?
          WHERE app_id = ? AND environment_id = ? AND installation_id = ?`)
        .bind(now, now, scope.appId, scope.environmentId, installationId)
        .run();
    },

    /**
     * System read for the cron. Claims nothing, because a single dispatcher runs per
     * cron tick, and the cursor advance is idempotent, so a lease would buy
     * nothing that redelivery safety does not already provide.
     */
    async dueInstallations(now: string, limit: number): Promise<SentryInstallationRow[]> {
      const rows = await d1
        .prepare(
          `${INSTALLATION_SELECT} WHERE status = 'active' AND next_attempt_at <= ?
          ORDER BY next_attempt_at ASC LIMIT ?`,
        )
        .bind(now, limit)
        .all<SentryInstallationRow>();
      return rows.results;
    },

    /** Lowest cursor across active installations; governs audit-log retention. */
    async minUndeliveredSeq(): Promise<number | null> {
      const row = await d1
        .prepare(
          `SELECT MIN(COALESCE(last_delivered_seq, 0)) AS minSeq
          FROM sentry_installations WHERE status = 'active'`,
        )
        .first<{ minSeq: number | null }>();
      return row?.minSeq ?? null;
    },

    async recordSuccess(installationId: string, deliveredSeq: number, now: string): Promise<void> {
      await d1
        .prepare(`UPDATE sentry_installations SET
          last_delivered_seq = MAX(COALESCE(last_delivered_seq, 0), ?), last_delivered_at = ?,
          attempt_count = 0, next_attempt_at = ?, latest_delivery_error_json = NULL, updated_at = ?
          WHERE installation_id = ?`)
        .bind(deliveredSeq, now, now, now, installationId)
        .run();
    },

    /**
     * Leaves `last_delivered_seq` untouched: the batch is retried from the same
     * cursor. Sentry deduplicates on `change_id`, so a redelivered batch is a
     * no-op on their side rather than a duplicate audit entry.
     */
    async recordFailure(
      installationId: string,
      input: { nextAttemptAt: string; errorJson: string; now: string },
    ): Promise<void> {
      await d1
        .prepare(`UPDATE sentry_installations SET
          attempt_count = attempt_count + 1, next_attempt_at = ?,
          latest_delivery_error_json = ?, updated_at = ?
          WHERE installation_id = ?`)
        .bind(input.nextAttemptAt, input.errorJson, input.now, installationId)
        .run();
    },
  };
}

const INSTALLATION_SELECT = `SELECT
  installation_id AS installationId, app_id AS appId, environment_id AS environmentId,
  webhook_url AS webhookUrl, secret_ciphertext AS secretCiphertext,
  secret_key_version AS secretKeyVersion, secret_fingerprint AS secretFingerprint,
  last_rotation_id AS lastRotationId, last_rotation_fingerprint AS lastRotationFingerprint,
  status, last_delivered_seq AS lastDeliveredSeq, last_delivered_at AS lastDeliveredAt,
  attempt_count AS attemptCount, next_attempt_at AS nextAttemptAt,
  latest_delivery_error_json AS latestDeliveryErrorJson, created_at AS createdAt,
  updated_at AS updatedAt, revoked_at AS revokedAt FROM sentry_installations`;
