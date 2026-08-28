import type { EvaluationCommitOutbox } from "./evaluation-commit-outbox";
import { registerEntityEvaluationCommit } from "./entity-metric-privacy";
import type { Env } from "./types";

interface InventoryCommit {
  identity: string;
  outbox: EvaluationCommitOutbox;
  commit: { payload: { exposureRows: readonly Record<string, unknown>[] } };
}

export async function inventoryEvaluationExposures(
  prepared: InventoryCommit,
  env: Env,
): Promise<void> {
  const suppressedEventIds = [];
  for (const row of prepared.commit.payload.exposureRows) {
    const eventId = rowString(row, "event_id");
    const suppressed = await registerEntityEvaluationCommit(
      env.ENTITY_METRIC_PRIVACY,
      {
        appId: rowString(row, "app_id"),
        idType: rowString(row, "id_type"),
        entityFamilyHash: rowString(row, "entity_family_hash"),
      },
      {
        commitIdentity: prepared.identity,
        eventId,
        serverReceivedAt: rowString(row, "server_received_at"),
      },
      env.SPLITCH_PLATFORM_TARGET,
    );
    if (suppressed) suppressedEventIds.push(eventId);
  }
  if (suppressedEventIds.length > 0) {
    await prepared.outbox.privacyDelete(prepared.identity, suppressedEventIds);
  }
}

function rowString(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Evaluation commit ${field} is invalid`);
  }
  return value;
}
