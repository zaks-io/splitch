import { assignmentKey } from "@splitch/contracts";
import {
  type EntityPrivacyIdentity,
  resolveEntityPrivacyIdentity,
  type SaltStore,
} from "@splitch/privacy";
import type { AssignmentKv, AssignmentStoreLogger, AssignmentStoreValue } from "./assignment-store";
import { assignmentWriterName, readAssignmentValue } from "./assignment-store";
import {
  type EntityHoldoverWriteSuppression,
  type HoldoverWriteJob,
  holdoverWriteOutboxName,
} from "./holdover-write-outbox-core";

export interface AssignmentWriterNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  };
}

export interface EntityAssignmentExport {
  appId: string;
  idType: string;
  targetingKeyHashes: readonly string[];
  entityFamilyHash: string;
  records: readonly {
    targetingKeyHash: string;
    assignments: AssignmentStoreValue;
    holdoverWrites: readonly HoldoverWriteJob[];
    holdoverSuppression: EntityHoldoverWriteSuppression | null;
  }[];
  proofs: readonly string[];
}

export interface EntityAssignmentDeleteResult {
  appId: string;
  idType: string;
  targetingKeyHashes: readonly string[];
  entityFamilyHash: string;
  deletedKeyCount: number;
  deletedWriterCount: number;
  deletedOutboxCount: number;
  proofs: readonly string[];
}

export async function exportEntityAssignments(
  kv: AssignmentKv,
  outboxes: AssignmentWriterNamespace,
  saltStore: SaltStore,
  input: { appId: string; idType: string; targetingKey: string },
  logger?: AssignmentStoreLogger,
): Promise<EntityAssignmentExport> {
  const identity = await resolveEntityPrivacyIdentity(saltStore, input);
  const records = [];
  const proofs = [];
  for (const targetingKeyHash of identity.targetingKeyHashes) {
    const assignments = await readAssignmentValue(
      kv,
      assignmentKey(input.appId, input.idType, targetingKeyHash),
      logger,
    );
    const outbox = outboxes.get(
      outboxes.idFromName(
        holdoverWriteOutboxName({ appId: input.appId, idType: input.idType, targetingKeyHash }),
      ),
    );
    const outboxResponse = await outbox.fetch("https://holdover-write-outbox.internal/export");
    if (!outboxResponse.ok) {
      throw new Error(`Holdover write outbox export failed with HTTP ${outboxResponse.status}`);
    }
    const holdover = parseHoldoverExport(await outboxResponse.json());
    proofs.push(`${targetingKeyHash}:assignment-and-holdover-exported-v1`);
    if (Object.keys(assignments).length > 0 || holdover.jobs.length > 0 || holdover.suppression) {
      records.push({
        targetingKeyHash,
        assignments,
        holdoverWrites: holdover.jobs,
        holdoverSuppression: holdover.suppression,
      });
    }
  }
  return { ...exportedIdentity(identity, records), proofs };
}

export async function deleteEntityAssignments(
  kv: AssignmentKv,
  writers: AssignmentWriterNamespace,
  outboxes: AssignmentWriterNamespace,
  saltStore: SaltStore,
  input: { appId: string; idType: string; targetingKey: string },
  deleteBeforeTs: string,
): Promise<EntityAssignmentDeleteResult> {
  if (kv.delete === undefined) {
    throw new Error("Assignment KV delete is unavailable");
  }
  const identity = await resolveEntityPrivacyIdentity(saltStore, input);
  const proofs = [];
  for (const targetingKeyHash of identity.targetingKeyHashes) {
    proofs.push(
      await deleteHoldoverOutbox(outboxes, input, targetingKeyHash, deleteBeforeTs),
      await deleteAssignmentWriter(writers, input, targetingKeyHash),
    );
    await kv.delete(assignmentKey(input.appId, input.idType, targetingKeyHash));
  }
  const deletedStoreCount = identity.targetingKeyHashes.length;
  return {
    appId: identity.appId,
    idType: identity.idType,
    targetingKeyHashes: identity.targetingKeyHashes,
    entityFamilyHash: identity.entityFamilyHash,
    deletedKeyCount: deletedStoreCount,
    deletedWriterCount: deletedStoreCount,
    deletedOutboxCount: deletedStoreCount,
    proofs,
  };
}

async function deleteHoldoverOutbox(
  outboxes: AssignmentWriterNamespace,
  input: { appId: string; idType: string },
  targetingKeyHash: string,
  deleteBeforeTs: string,
): Promise<string> {
  const name = holdoverWriteOutboxName({
    appId: input.appId,
    idType: input.idType,
    targetingKeyHash,
  });
  const outbox = outboxes.get(outboxes.idFromName(name));
  const response = await outbox.fetch("https://holdover-write-outbox.internal/delete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      appId: input.appId,
      idType: input.idType,
      targetingKeyHash,
      deleteBeforeTsMs: Date.parse(deleteBeforeTs),
    }),
  });
  if (!response.ok) {
    throw new Error(`Holdover write outbox delete failed with HTTP ${response.status}`);
  }
  const result = (await response.json()) as { ok?: unknown };
  if (result.ok !== true) {
    throw new Error("Holdover write outbox delete returned an invalid proof");
  }
  return `${targetingKeyHash}:holdover-write-outbox-suppressed-and-purged-v1`;
}

async function deleteAssignmentWriter(
  writers: AssignmentWriterNamespace,
  input: { appId: string; idType: string },
  targetingKeyHash: string,
): Promise<string> {
  const name = assignmentWriterName({
    appId: input.appId,
    idType: input.idType,
    targetingKeyHash,
  });
  const writer = writers.get(writers.idFromName(name));
  const response = await writer.fetch("https://assignment-store.internal/delete", {
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`Assignment writer delete failed with HTTP ${response.status}`);
  }
  const result = (await response.json()) as { deleted?: unknown; proof?: unknown };
  if (result.deleted !== true || typeof result.proof !== "string" || result.proof.length === 0) {
    throw new Error("Assignment writer delete returned an invalid proof");
  }
  return `${targetingKeyHash}:${result.proof}`;
}

function parseHoldoverExport(value: unknown): {
  jobs: HoldoverWriteJob[];
  suppression: EntityHoldoverWriteSuppression | null;
} {
  if (typeof value !== "object" || value === null) {
    throw new Error("Holdover write outbox export returned an invalid body");
  }
  const body = value as { jobs?: unknown; suppression?: unknown };
  if (
    !Array.isArray(body.jobs) ||
    !(body.suppression === null || isSuppression(body.suppression))
  ) {
    throw new Error("Holdover write outbox export returned an invalid body");
  }
  return {
    jobs: body.jobs as HoldoverWriteJob[],
    suppression: body.suppression,
  };
}

function isSuppression(value: unknown): value is EntityHoldoverWriteSuppression {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { deleteBeforeTsMs?: unknown }).deleteBeforeTsMs === "number"
  );
}

function exportedIdentity(
  identity: EntityPrivacyIdentity,
  records: EntityAssignmentExport["records"],
): Omit<EntityAssignmentExport, "proofs"> {
  return {
    appId: identity.appId,
    idType: identity.idType,
    targetingKeyHashes: identity.targetingKeyHashes,
    entityFamilyHash: identity.entityFamilyHash,
    records,
  };
}
