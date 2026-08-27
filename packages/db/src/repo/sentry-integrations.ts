/**
 * Sentry change-tracking installations.
 *
 * Organization-scoped, not App/Environment-scoped: Sentry keeps one signing
 * secret per provider type per organization and its flag log has no project or
 * environment axis, so the Organization is the only binding that matches what
 * Sentry can actually store. `org_id` is the isolation predicate here, the same
 * way `app_id` is for tenant tables (ADR-0018), and every method below takes it.
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
  orgId: string;
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
      orgId: string,
      installationId: string,
    ): Promise<SentryInstallationRow | null> {
      assertOrgId(orgId);
      return d1
        .prepare(`${INSTALLATION_SELECT} WHERE org_id = ? AND installation_id = ?`)
        .bind(orgId, installationId)
        .first<SentryInstallationRow>();
    },

    /**
     * Every installation this Organization has ever had, newest first. Revoked
     * rows are included: they are the record of where Flag changes used to be
     * sent, and hiding them would make a revoked Sentry org indistinguishable
     * from one that was never wired up.
     */
    async listInstallations(
      orgId: string,
      options?: { limit?: number },
    ): Promise<SentryInstallationRow[]> {
      assertOrgId(orgId);
      const limit = options?.limit;
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
        throw new Error(`listInstallations: limit must be a positive integer, got ${limit}`);
      }
      const sql =
        limit === undefined
          ? `${INSTALLATION_SELECT} WHERE org_id = ? ORDER BY created_at DESC`
          : `${INSTALLATION_SELECT} WHERE org_id = ? ORDER BY created_at DESC LIMIT ?`;
      const statement =
        limit === undefined ? d1.prepare(sql).bind(orgId) : d1.prepare(sql).bind(orgId, limit);
      const rows = await statement.all<SentryInstallationRow>();
      return rows.results;
    },

    /**
     * Fails loud on a duplicate rather than INSERT OR IGNORE: a second
     * installation against an Organization that already has one is a
     * misconfiguration the caller must see, not a silent no-op that would leave
     * them believing a different Sentry org was wired up.
     */
    async createInstallation(
      orgId: string,
      input: SentryInstallationWrite,
    ): Promise<SentryInstallationRow> {
      assertOrgId(orgId);
      await d1
        .prepare(`INSERT INTO sentry_installations (
          installation_id, org_id, webhook_url, secret_ciphertext,
          secret_key_version, secret_fingerprint, status, next_attempt_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`)
        .bind(
          input.installationId,
          orgId,
          input.webhookUrl,
          input.secretCiphertext,
          input.secretKeyVersion,
          input.secretFingerprint,
          input.now,
          input.now,
          input.now,
        )
        .run();
      const row = await this.getInstallation(orgId, input.installationId);
      if (!row) throw new Error("sentry integrations: installation insert did not produce a row");
      return row;
    },

    async rotateSecret(
      orgId: string,
      installationId: string,
      input: Pick<
        SentryInstallationWrite,
        "secretCiphertext" | "secretKeyVersion" | "secretFingerprint" | "now"
      > & { rotationId: string },
    ): Promise<SentryInstallationRow | null> {
      assertOrgId(orgId);
      await d1
        .prepare(`UPDATE sentry_installations SET
          secret_ciphertext = ?, secret_key_version = ?, secret_fingerprint = ?,
          last_rotation_id = ?, last_rotation_fingerprint = ?, updated_at = ?
          WHERE org_id = ? AND installation_id = ? AND status = 'active'`)
        .bind(
          input.secretCiphertext,
          input.secretKeyVersion,
          input.secretFingerprint,
          input.rotationId,
          input.secretFingerprint,
          input.now,
          orgId,
          installationId,
        )
        .run();
      return this.getInstallation(orgId, installationId);
    },

    async revokeInstallation(orgId: string, installationId: string, now: string): Promise<void> {
      assertOrgId(orgId);
      await d1
        .prepare(`UPDATE sentry_installations SET status = 'revoked',
          revoked_at = COALESCE(revoked_at, ?), updated_at = ?
          WHERE org_id = ? AND installation_id = ?`)
        .bind(now, now, orgId, installationId)
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
  installation_id AS installationId, org_id AS orgId,
  webhook_url AS webhookUrl, secret_ciphertext AS secretCiphertext,
  secret_key_version AS secretKeyVersion, secret_fingerprint AS secretFingerprint,
  last_rotation_id AS lastRotationId, last_rotation_fingerprint AS lastRotationFingerprint,
  status, last_delivered_seq AS lastDeliveredSeq, last_delivered_at AS lastDeliveredAt,
  attempt_count AS attemptCount, next_attempt_at AS nextAttemptAt,
  latest_delivery_error_json AS latestDeliveryErrorJson, created_at AS createdAt,
  updated_at AS updatedAt, revoked_at AS revokedAt FROM sentry_installations`;

/**
 * The Organization is the isolation predicate for every read and write here, so
 * a blank one would silently widen the query to "any installation with this id".
 * Fail loud instead (ADR-0036), the same refusal `appScope`/`envScope` make for
 * the tenant tables.
 */
function assertOrgId(orgId: string): void {
  if (!orgId) throw new Error("sentry integrations: orgId is required and must be non-empty");
}
