import type { Repository } from "@splitch/db";
import type { EntityPrivacyConsumer } from "./entity-privacy-consumer";
import {
  assertStoreIdentity,
  EntityPrivacyConsumerError,
  type EntityPrivacyConsumerInput,
  type EntityPrivacyStoreResult,
} from "./entity-privacy-service-client";

const LEASE_MS = 5 * 60 * 1000;
const DELETE_STORES = [
  "analysis-suppression",
  "event-ingest-suppression",
  "d1-tombstone",
  "assignments",
  "analysis",
  "event-ingest",
] as const;

type DeleteStore = (typeof DELETE_STORES)[number];
type StoreState = "pending" | "done" | "failed";
export type EntityDeleteStoreStatus = Record<DeleteStore, StoreState>;

export function initialEntityDeleteStoreStatus(): EntityDeleteStoreStatus {
  return Object.fromEntries(
    DELETE_STORES.map((store) => [store, "pending"]),
  ) as EntityDeleteStoreStatus;
}

export async function runEntityDeleteJob(input: {
  repo: Repository;
  coordinator: {
    recordEntityDeletionSuppression(
      appId: string,
      expectedVersion: string,
      value: { idType: string; targetingKeyHashes: readonly string[]; deleteBeforeTs: string },
    ): Promise<void>;
  };
  consumer: EntityPrivacyConsumer;
  input: EntityPrivacyConsumerInput;
  identity: EntityPrivacyStoreResult;
  requestId: string;
  job: {
    status: "queued" | "running" | "completed" | "failed";
    storeStatusJson: string;
    deleteBeforeTs: string | null;
    identityVersion: string;
  };
  nowIso?: () => string;
}): Promise<void> {
  if (input.job.status === "completed") return;
  const now = input.nowIso?.() ?? new Date().toISOString();
  const claimed = await input.repo.privacy.claimPrivacyJob(
    input.requestId,
    now,
    new Date(Date.parse(now) + LEASE_MS).toISOString(),
  );
  if (!claimed) return;
  const deleteBeforeTs = claimed.deleteBeforeTs;
  if (!deleteBeforeTs) throw new Error("Entity privacy delete job has no deletion cutoff");
  const states = parseDeleteStoreStatus(claimed.storeStatusJson);

  await step(input, states, "analysis-suppression", () =>
    input.consumer.suppressAnalysis(input.input, input.identity, deleteBeforeTs),
  );
  await step(input, states, "event-ingest-suppression", () =>
    input.consumer.suppressEvents(input.input, input.identity, deleteBeforeTs),
  );
  await step(input, states, "d1-tombstone", () =>
    input.coordinator.recordEntityDeletionSuppression(input.input.appId, claimed.identityVersion, {
      idType: input.input.idType,
      targetingKeyHashes: input.identity.targetingKeyHashes,
      deleteBeforeTs,
    }),
  );
  await step(input, states, "assignments", async () => {
    const result = await input.consumer.deleteAssignments(input.input, deleteBeforeTs);
    assertStoreIdentity(input.identity, result, "Assignment deletion");
  });
  await step(input, states, "analysis", () =>
    input.consumer.deleteAnalysis(input.input, input.identity, deleteBeforeTs),
  );
  await step(input, states, "event-ingest", () =>
    input.consumer.deleteEvents(input.input, input.identity, deleteBeforeTs),
  );
  await input.repo.privacy.updatePrivacyJob({
    requestId: input.requestId,
    status: "completed",
    storeStatusJson: JSON.stringify(states),
    updatedAt: input.nowIso?.() ?? new Date().toISOString(),
  });
}

async function step(
  input: Parameters<typeof runEntityDeleteJob>[0],
  states: EntityDeleteStoreStatus,
  store: DeleteStore,
  operation: () => Promise<unknown>,
): Promise<void> {
  if (states[store] === "done") return;
  try {
    await operation();
    states[store] = "done";
    await input.repo.privacy.updatePrivacyJob({
      requestId: input.requestId,
      status: "running",
      storeStatusJson: JSON.stringify(states),
      updatedAt: input.nowIso?.() ?? new Date().toISOString(),
    });
  } catch (cause) {
    states[store] = "failed";
    await input.repo.privacy.updatePrivacyJob({
      requestId: input.requestId,
      status: "failed",
      storeStatusJson: JSON.stringify(states),
      updatedAt: input.nowIso?.() ?? new Date().toISOString(),
      errorCode: "PRIVACY_STORE_FAILED",
    });
    throw cause instanceof EntityPrivacyConsumerError
      ? cause
      : new EntityPrivacyConsumerError(`control-plane-api: ${store} failed`);
  }
}

function parseDeleteStoreStatus(value: string): EntityDeleteStoreStatus {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Entity privacy delete job has malformed store state");
  }
  const record = parsed as Record<string, unknown>;
  if (
    DELETE_STORES.some(
      (store) =>
        record[store] !== "pending" && record[store] !== "done" && record[store] !== "failed",
    )
  ) {
    throw new Error("Entity privacy delete job has malformed store state");
  }
  return record as EntityDeleteStoreStatus;
}
