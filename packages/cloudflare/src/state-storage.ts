import type { CloudflareConfigSnapshot } from "@splitch/contracts";
import {
  configSnapshotProvider,
  type Provider,
  parseConfigSnapshot,
} from "@splitch/evaluation-core";
import { type ExposureRow, nextExposureAttempt } from "./exposure-delivery";

const RETENTION_MS = 30 * 86_400_000;

export interface IntegrationRow {
  [key: string]: string | number | null | ArrayBuffer;
  installationId: string;
  appId: string;
  environmentId: string;
  identityKey: string;
  announcedVersion: number;
  snapshotVersion: number;
}

export class StateStorage {
  private cachedConfiguration:
    | { snapshotVersion: number; snapshot: CloudflareConfigSnapshot; provider: Provider }
    | undefined;

  constructor(private readonly storage: DurableObjectStorage) {}

  initialize(schema: string): void {
    this.storage.sql.exec(schema);
    const columns = this.storage.sql
      .exec<{ name: string }>("PRAGMA table_info(integration)")
      .toArray();
    if (columns.some(({ name }) => name === "announced_version")) {
      this.storage.sql.exec("INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (2)");
      return;
    }
    this.storage.transactionSync(() => {
      this.storage.sql.exec(
        "ALTER TABLE integration ADD COLUMN announced_version INTEGER NOT NULL DEFAULT 0",
      );
      this.storage.sql.exec("UPDATE integration SET announced_version = snapshot_version");
      this.storage.sql.exec("INSERT INTO _sql_schema_migrations (id) VALUES (2)");
    });
  }

  integration(): IntegrationRow | null {
    return (
      this.storage.sql
        .exec<IntegrationRow>(`SELECT installation_id AS installationId, app_id AS appId,
          environment_id AS environmentId, identity_key AS identityKey,
          announced_version AS announcedVersion, snapshot_version AS snapshotVersion
          FROM integration WHERE singleton = 1`)
        .toArray()[0] ?? null
    );
  }

  announceVersion(version: number): void {
    this.storage.sql.exec(
      "UPDATE integration SET announced_version = MAX(announced_version, ?) WHERE singleton = 1",
      version,
    );
  }

  configuration(
    snapshotVersion: number,
  ): { snapshot: CloudflareConfigSnapshot; provider: Provider } | null {
    if (this.cachedConfiguration?.snapshotVersion === snapshotVersion)
      return this.cachedConfiguration;
    const row = this.storage.sql
      .exec<{ payload: string }>("SELECT payload FROM snapshot WHERE singleton = 1")
      .toArray()[0];
    if (!row) return null;
    const snapshot = parseConfigSnapshot(row.payload, "Cloudflare");
    const configuration = {
      snapshotVersion,
      snapshot,
      provider: configSnapshotProvider(snapshot, "Cloudflare"),
    };
    this.cachedConfiguration = configuration;
    return configuration;
  }

  invalidateConfiguration(): void {
    this.cachedConfiguration = undefined;
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

  pruneExpired(now: number): void {
    const cutoff = new Date(now - RETENTION_MS).toISOString();
    const cutoffMs = now - RETENTION_MS;
    this.storage.transactionSync(() => {
      this.storage.sql.exec("DELETE FROM evaluation_claims WHERE created_at <= ?", cutoff);
      this.storage.sql.exec(
        "DELETE FROM exposure_outbox WHERE state = 'terminal' AND created_at <= ?",
        cutoffMs,
      );
      this.storage.sql.exec("DELETE FROM push_claims WHERE applied_at <= ?", cutoff);
    });
  }

  async ensureAlarm(now = Date.now()): Promise<void> {
    const pending = this.storage.sql
      .exec<{ nextAttemptAt: number }>(
        "SELECT MIN(next_attempt_at) AS nextAttemptAt FROM exposure_outbox WHERE state = 'pending'",
      )
      .toArray()[0]?.nextAttemptAt;
    const retentionCandidates = [
      this.oldestIso("evaluation_claims", "created_at"),
      this.oldestTerminalExposure(),
      this.oldestIso("push_claims", "applied_at"),
    ]
      .filter((value): value is number => typeof value === "number")
      .map((value) => value + RETENTION_MS);
    const candidates = [...(typeof pending === "number" ? [pending] : []), ...retentionCandidates];
    if (candidates.length > 0) await this.storage.setAlarm(Math.max(now, Math.min(...candidates)));
  }

  private oldestIso(
    table: "evaluation_claims" | "push_claims",
    column: "created_at" | "applied_at",
  ): number | null {
    const row = this.storage.sql
      .exec<{ oldest: string }>(`SELECT MIN(${column}) AS oldest FROM ${table}`)
      .toArray()[0];
    return row?.oldest ? Date.parse(row.oldest) : null;
  }

  private oldestTerminalExposure(): number | null {
    return (
      this.storage.sql
        .exec<{ oldest: number }>(
          "SELECT MIN(created_at) AS oldest FROM exposure_outbox WHERE state = 'terminal'",
        )
        .toArray()[0]?.oldest ?? null
    );
  }
}
