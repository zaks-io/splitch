import {
  registerAppEvaluationCommit,
  registerEntityEvaluationCommit,
} from "./entity-metric-privacy";
import type { EvaluationCommitOutbox } from "./evaluation-commit-outbox";
import type { Env } from "./types";

interface InventoryCommit {
  identity: string;
  outbox: EvaluationCommitOutbox;
  payload: {
    usage: { appId: string; identityVersion: string };
    exposureRows: readonly Record<string, unknown>[];
  };
}

export async function inventoryEvaluationCommit(
  prepared: InventoryCommit,
  env: Env,
): Promise<boolean> {
  const scopeAppId = prepared.payload.usage.appId;
  if (typeof scopeAppId !== "string" || scopeAppId.length === 0) {
    throw new Error("Evaluation commit app_id is invalid");
  }
  const appSuppressed = await registerAppEvaluationCommit(
    env.ENTITY_METRIC_PRIVACY,
    {
      appId: scopeAppId,
      commitIdentity: prepared.identity,
      identityVersion: prepared.payload.usage.identityVersion,
    },
    env.SPLITCH_PLATFORM_TARGET,
  );
  if (appSuppressed) {
    await prepared.outbox.privacyDeleteAll(prepared.identity);
    return true;
  }
  const suppressedEventIds = [];
  for (const row of prepared.payload.exposureRows) {
    const eventId = rowString(row, "event_id");
    const suppressed = await registerEntityEvaluationCommit(
      env.ENTITY_METRIC_PRIVACY,
      {
        appId: rowString(row, "app_id"),
        idType: rowString(row, "id_type"),
        entityFamilyHash: rowString(row, "entity_family_hash"),
        identityVersion: identityVersion(rowString(row, "targeting_key_hash")),
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
  return false;
}

export async function confirmEvaluationCommitInventory(
  prepared: InventoryCommit,
  env: Env,
): Promise<void> {
  const suppressed = await registerAppEvaluationCommit(
    env.ENTITY_METRIC_PRIVACY,
    {
      appId: prepared.payload.usage.appId,
      commitIdentity: prepared.identity,
      identityVersion: prepared.payload.usage.identityVersion,
    },
    env.SPLITCH_PLATFORM_TARGET,
  );
  if (!suppressed) return;
  await prepared.outbox.privacyDeleteAll(prepared.identity);
  throw new Error("Evaluation commit raced App identity reset");
}

function identityVersion(targetingKeyHash: string): string {
  const separator = targetingKeyHash.indexOf(":");
  if (separator <= 0) throw new Error("Evaluation commit targeting_key_hash is invalid");
  return targetingKeyHash.slice(0, separator);
}

function rowString(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Evaluation commit ${field} is invalid`);
  }
  return value;
}
