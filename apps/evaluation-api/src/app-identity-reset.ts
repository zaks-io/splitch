import { requireDestroyedIdentityVersions } from "./assignment/app-identity-reset-fence";
import { assignmentWriterName } from "@splitch/contracts";
import type { HoldoverWriteAppInventoryStatus } from "./assignment/holdover-write-app-inventory";
import { DurableHoldoverWriteAppInventoryClient } from "./assignment/holdover-write-app-inventory-client";
import { holdoverWriteOutboxName } from "./assignment/holdover-write-outbox-core";
import type { EvaluationApiEnv } from "./env";
import { exposureRedemptionClaimScopeName } from "./exposure-redemption-claim";

export async function purgeAppIdentityAssignments(
  env: EvaluationApiEnv,
  appId: string,
  resetId: string,
  destroyedVersions: readonly string[],
): Promise<string> {
  const resetVersions = requireDestroyedIdentityVersions(destroyedVersions);
  const inventory = new DurableHoldoverWriteAppInventoryClient(
    required(env.HOLDOVER_WRITE_APP_INVENTORY, "HOLDOVER_WRITE_APP_INVENTORY"),
  );
  const status = await inventory.status(appId);
  if (isOpenInventory(status)) {
    await registerSettledAssignmentWriters(env.ASSIGNMENTS_KV, inventory, appId);
  }
  await inventory.beginDeletion(appId, resetId, Date.now());
  const frozen = await frozenResetInventory(inventory, appId, resetId);
  let durableObjects = 0;
  for (const ref of frozen.entities) {
    const identity = { appId, ...ref };
    const writers = env.ASSIGNMENT_STORE_WRITER;
    const writerResponse = await writers
      .get(writers.idFromName(assignmentWriterName(identity)))
      .fetch("https://assignment-store.local/reset-app", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...identity, destroyedVersions: resetVersions }),
      });
    await requireAssignmentWriterReset(writerResponse, resetVersions);

    const outbox = required(env.HOLDOVER_WRITE_OUTBOX, "HOLDOVER_WRITE_OUTBOX");
    const outboxResponse = await outbox
      .get(outbox.idFromName(holdoverWriteOutboxName(identity)))
      .fetch("https://holdover-write-outbox.local/reset-app", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ destroyedVersions: resetVersions }),
      });
    await requireOutboxReset(outboxResponse, resetVersions);
    await inventory.markEntityPurged(appId, ref);
    durableObjects += 2;
  }

  const verified = await frozenResetInventory(inventory, appId, resetId);
  if (verified.entities.length > 0) {
    throw new Error(
      `App identity reset Assignment inventory still contains ${String(verified.entities.length)} Entity checkpoint(s)`,
    );
  }
  const deletedKeys = await deleteKvPrefix(env.ASSIGNMENTS_KV, `assignment:${appId}:`);
  return `evaluation-assignments:kv=${deletedKeys};durable_inventory=empty;durable_objects=${durableObjects}`;
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
  identityVersion: string,
): Promise<void> {
  const inventory = new DurableHoldoverWriteAppInventoryClient(
    required(env.HOLDOVER_WRITE_APP_INVENTORY, "HOLDOVER_WRITE_APP_INVENTORY"),
  );
  const status = await inventory.status(appId);
  assertResetCancellationReady(status, resetId);
  const cancellation = await inventory.completeIdentityReset(appId, resetId, identityVersion);
  if (!cancellation.cancelled || !cancellation.done) {
    throw new Error(
      `App identity reset Assignment cancellation is incomplete in phase ${cancellation.sagaPhase ?? "idle"} with ${String(cancellation.entities.length)} Entity checkpoint(s) pending`,
    );
  }
  const restored = await inventory.status(appId);
  if (!isIdleInventory(restored)) {
    throw new Error("App identity reset Assignment cancellation did not restore idle inventory");
  }
}

function assertResetCancellationReady(
  status: HoldoverWriteAppInventoryStatus,
  resetId: string,
): void {
  if (status.entities.length > 0) {
    throw new Error(
      `App identity reset cannot cancel Assignment suppression with ${String(status.entities.length)} Entity checkpoint(s) pending`,
    );
  }
  if (!isIdleInventory(status) && !isResetCancellationInventory(status, resetId)) {
    throw new Error("App identity reset Assignment inventory cannot be cancelled by this reset");
  }
}

function isIdleInventory(status: HoldoverWriteAppInventoryStatus): boolean {
  return (
    status.generationId === null &&
    !status.suppressed &&
    !status.deletionComplete &&
    status.deleteBeforeTsMs === null &&
    status.entities.length === 0 &&
    status.sagaPhase === null
  );
}

function isOpenInventory(status: HoldoverWriteAppInventoryStatus): boolean {
  return (
    status.generationId === null &&
    !status.suppressed &&
    !status.deletionComplete &&
    status.deleteBeforeTsMs === null &&
    status.sagaPhase === null
  );
}

function isResetCancellationInventory(
  status: HoldoverWriteAppInventoryStatus,
  resetId: string,
): boolean {
  return (
    status.generationId === resetId &&
    status.suppressed &&
    !status.deletionComplete &&
    status.deleteBeforeTsMs !== null &&
    (status.sagaPhase === "prepared" || status.sagaPhase === "canceling")
  );
}

async function frozenResetInventory(
  inventory: DurableHoldoverWriteAppInventoryClient,
  appId: string,
  resetId: string,
): Promise<HoldoverWriteAppInventoryStatus & { readonly deleteBeforeTsMs: number }> {
  const status = await inventory.status(appId);
  if (
    status.generationId !== resetId ||
    !status.suppressed ||
    status.deletionComplete ||
    status.sagaPhase !== "prepared" ||
    status.deleteBeforeTsMs === null
  ) {
    throw new Error("App identity reset Assignment inventory is not frozen for this reset");
  }
  return { ...status, deleteBeforeTsMs: status.deleteBeforeTsMs };
}

async function requireAssignmentWriterReset(
  response: Response,
  destroyedVersions: readonly string[],
): Promise<void> {
  if (!response.ok) {
    throw new Error(`App identity reset Assignment writer purge returned HTTP ${response.status}`);
  }
  const body = await response.json().catch(() => null);
  if (
    !isRecord(body) ||
    body.deleted !== true ||
    !isEmptyRecord(body.assignments) ||
    !includesVersions(body.fencedIdentityVersions, destroyedVersions) ||
    body.proof !== "assignment-do-app-reset-v1"
  ) {
    throw new Error("App identity reset Assignment writer purge returned an invalid proof");
  }
}

async function requireOutboxReset(
  response: Response,
  destroyedVersions: readonly string[],
): Promise<void> {
  if (!response.ok) {
    throw new Error(`App identity reset outbox purge returned HTTP ${response.status}`);
  }
  const body = await response.json().catch(() => null);
  if (
    !isRecord(body) ||
    !Array.isArray(body.jobs) ||
    body.jobs.length > 0 ||
    !includesVersions(body.fencedIdentityVersions, destroyedVersions) ||
    body.proof !== "holdover-write-outbox-app-reset-v1"
  ) {
    throw new Error("App identity reset outbox purge did not durably checkpoint the Entity");
  }
}

function isEmptyRecord(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length === 0;
}

function includesVersions(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.every((version) => typeof version === "string") &&
    expected.every((version) => value.includes(version))
  );
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

async function registerSettledAssignmentWriters(
  kv: KVNamespace,
  inventory: DurableHoldoverWriteAppInventoryClient,
  appId: string,
): Promise<void> {
  const prefix = `assignment:${appId}:`;
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix, ...(cursor ? { cursor } : {}) });
    for (const key of page.keys) {
      const ref = assignmentRefFromKvKey(key.name, prefix);
      const result = await inventory.registerEntity(appId, ref);
      if (result.status !== "registered") {
        throw new Error("App identity reset Assignment inventory froze during winner discovery");
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}

function assignmentRefFromKvKey(
  key: string,
  prefix: string,
): { readonly idType: string; readonly targetingKeyHash: string } {
  const suffix = key.slice(prefix.length);
  const separator = suffix.indexOf(":");
  if (!key.startsWith(prefix) || separator <= 0 || separator === suffix.length - 1) {
    throw new Error(`Invalid Assignment KV key in App reset inventory: ${key}`);
  }
  return {
    idType: suffix.slice(0, separator),
    targetingKeyHash: suffix.slice(separator + 1),
  };
}

function required<T>(value: T | undefined, name: string): T {
  if (!value) throw new Error(`${name} is required for App identity reset`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
