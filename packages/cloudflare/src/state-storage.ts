import type { CloudflareConfigSnapshot } from "@splitch/contracts";
import { parseConfigSnapshot } from "@splitch/evaluation-core";
import { type ExposureRow, nextExposureAttempt } from "./exposure-delivery";

export interface IntegrationRow {
  [key: string]: string | number | null | ArrayBuffer;
  installationId: string;
  appId: string;
  environmentId: string;
  identityKey: string;
  snapshotVersion: number;
}

export class StateStorage {
  constructor(private readonly storage: DurableObjectStorage) {}

  initialize(schema: string): void {
    this.storage.sql.exec(schema);
  }

  integration(): IntegrationRow | null {
    return (
      this.storage.sql
        .exec<IntegrationRow>(`SELECT installation_id AS installationId, app_id AS appId,
          environment_id AS environmentId, identity_key AS identityKey,
          snapshot_version AS snapshotVersion FROM integration WHERE singleton = 1`)
        .toArray()[0] ?? null
    );
  }

  snapshot(): CloudflareConfigSnapshot | null {
    const row = this.storage.sql
      .exec<{ payload: string }>("SELECT payload FROM snapshot WHERE singleton = 1")
      .toArray()[0];
    return row ? parseConfigSnapshot(row.payload, "Cloudflare") : null;
  }

  claim(idempotencyKey: string): { fingerprint: string; resultJson: string } | null {
    return (
      this.storage.sql
        .exec<{ fingerprint: string; resultJson: string }>(
          "SELECT fingerprint, result_json AS resultJson FROM evaluation_claims WHERE idempotency_key = ?",
          idempotencyKey,
        )
        .toArray()[0] ?? null
    );
  }

  assignments(idType: string, targetingKeyHash: string) {
    const rows = this.storage.sql
      .exec<{ experimentId: string; runId: string; variant: string }>(
        `SELECT experiment_id AS experimentId, run_id AS runId, variant FROM assignments
         WHERE id_type = ? AND targeting_key_hash = ?`,
        idType,
        targetingKeyHash,
      )
      .toArray();
    return new Map(
      rows.map((row) => [row.experimentId, { runId: row.runId, variant: row.variant }]),
    );
  }

  recordPushClaim(deliveryId: string, version: number, now: string): void {
    this.storage.sql.exec(
      "INSERT OR IGNORE INTO push_claims (delivery_id, environment_version, applied_at) VALUES (?, ?, ?)",
      deliveryId,
      version,
      now,
    );
  }

  dueExposures(now: number): ExposureRow[] {
    return this.storage.sql
      .exec<ExposureRow>(
        `SELECT exposure_id AS exposureId, installation_id AS installationId,
        flag_key AS flagKey, experiment_id AS experimentId, run_id AS runId,
        run_config_hash AS runConfigHash, context_json AS contextJson, variant_name AS variantName,
        exposed_at AS exposedAt, attempt_count AS attemptCount, created_at AS createdAt
        FROM exposure_outbox WHERE state = 'pending' AND next_attempt_at <= ?
        AND context_json IS NOT NULL ORDER BY next_attempt_at LIMIT 25`,
        now,
      )
      .toArray();
  }

  finishExposure(row: ExposureRow, outcome: "accepted" | "retry" | "terminal", now: number): void {
    this.storage.transactionSync(() => {
      if (outcome === "accepted") {
        this.storage.sql.exec("DELETE FROM exposure_outbox WHERE exposure_id = ?", row.exposureId);
        return;
      }
      if (outcome === "terminal") {
        this.storage.sql.exec(
          `UPDATE exposure_outbox SET state = 'terminal', context_json = NULL,
           last_error = 'Exposure delivery was rejected or exceeded its privacy deadline'
           WHERE exposure_id = ?`,
          row.exposureId,
        );
        return;
      }
      const attempt = row.attemptCount + 1;
      this.storage.sql.exec(
        `UPDATE exposure_outbox SET attempt_count = ?, next_attempt_at = ?,
         last_error = 'Exposure delivery is retryable' WHERE exposure_id = ?`,
        attempt,
        now + nextExposureAttempt(row.exposureId, attempt),
        row.exposureId,
      );
    });
  }

  async ensureAlarm(): Promise<void> {
    const next = this.storage.sql
      .exec<{ nextAttemptAt: number }>(
        "SELECT MIN(next_attempt_at) AS nextAttemptAt FROM exposure_outbox WHERE state = 'pending'",
      )
      .toArray()[0]?.nextAttemptAt;
    if (typeof next === "number") await this.storage.setAlarm(next);
  }
}
