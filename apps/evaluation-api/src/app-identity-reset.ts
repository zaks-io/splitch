import {
  appHoldoverWriteSuppressKey,
  holdoverWriteOutboxName,
} from "./assignment/holdover-write-outbox-core";
import { assignmentWriterName } from "./assignment/assignment-store";
import { DurableHoldoverWriteAppInventoryClient } from "./assignment/holdover-write-app-inventory-client";
import { exposureRedemptionClaimScopeName } from "./exposure-redemption-claim";
import type { EvaluationApiEnv } from "./env";

export async function purgeAppIdentityAssignments(
  env: EvaluationApiEnv,
  appId: string,
  resetId: string,
): Promise<string> {
  const inventory = new DurableHoldoverWriteAppInventoryClient(
    required(env.HOLDOVER_WRITE_APP_INVENTORY, "HOLDOVER_WRITE_APP_INVENTORY"),
  );
  const cutoff = Date.now();
  const begun = await inventory.beginDeletion(appId, resetId, cutoff);
  let durableObjects = 0;
  for (const ref of begun.entities) {
    const identity = { appId, ...ref };
    const outbox = required(env.HOLDOVER_WRITE_OUTBOX, "HOLDOVER_WRITE_OUTBOX");
    const outboxResponse = await outbox
      .get(outbox.idFromName(holdoverWriteOutboxName(identity)))
      .fetch("https://holdover-write-outbox.local/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...identity, deleteBeforeTsMs: cutoff }),
      });
    if (!outboxResponse.ok) {
      throw new Error(`App identity reset outbox purge returned HTTP ${outboxResponse.status}`);
    }
    const writers = env.ASSIGNMENT_STORE_WRITER;
    const writerResponse = await writers
      .get(writers.idFromName(assignmentWriterName(identity)))
      .fetch("https://assignment-store.local/delete", { method: "POST" });
    if (!writerResponse.ok) {
      throw new Error(
        `App identity reset Assignment writer purge returned HTTP ${writerResponse.status}`,
      );
    }
    durableObjects += 2;
  }
  const deletedKeys = await deleteKvPrefix(env.ASSIGNMENTS_KV, `assignment:${appId}:`);
  return `evaluation-assignments:kv=${deletedKeys};durable_objects=${durableObjects}`;
}

export async function purgeAppIdentityRetryClaims(
  env: EvaluationApiEnv,
  appId: string,
  environmentIds: readonly string[],
): Promise<string> {
  const claims = required(env.EXPOSURE_REDEMPTION_CLAIMS, "EXPOSURE_REDEMPTION_CLAIMS");
  for (const environmentId of environmentIds) {
    const response = await claims
      .get(claims.idFromName(exposureRedemptionClaimScopeName(appId, environmentId)))
      .fetch("https://exposure-redemption-claim.local/delete-all", { method: "POST" });
    if (!response.ok) {
      throw new Error(`App identity reset retry claim purge returned HTTP ${response.status}`);
    }
  }
  return `evaluation-retry-claims:environments=${environmentIds.length}`;
}

export async function completeAppIdentityReset(
  env: EvaluationApiEnv,
  appId: string,
  resetId: string,
): Promise<void> {
  const inventory = new DurableHoldoverWriteAppInventoryClient(
    required(env.HOLDOVER_WRITE_APP_INVENTORY, "HOLDOVER_WRITE_APP_INVENTORY"),
  );
  await inventory.cancelDeletion(appId, resetId);
  if (env.ASSIGNMENTS_KV.delete === undefined) {
    throw new Error("ASSIGNMENTS_KV.delete is required to complete App identity reset");
  }
  await env.ASSIGNMENTS_KV.delete(appHoldoverWriteSuppressKey(appId));
}

async function deleteKvPrefix(kv: KVNamespace, prefix: string): Promise<number> {
  if (kv.delete === undefined) throw new Error("KV delete is unavailable");
  let cursor: string | undefined;
  let deleted = 0;
  do {
    const page = await kv.list({ prefix, ...(cursor ? { cursor } : {}) });
    for (const key of page.keys) {
      await kv.delete(key.name);
      deleted += 1;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return deleted;
}

function required<T>(value: T | undefined, name: string): T {
  if (!value) throw new Error(`${name} is required for App identity reset`);
  return value;
}
