import { assignmentWriterName } from "@splitch/contracts";
import {
  type EntityPrivacyIdentity,
  resolveEntityPrivacyIdentity,
  type SaltStore,
} from "@splitch/privacy";
import type { AssignmentKv, AssignmentStoreLogger } from "./assignment-store";
import {
  type EntityAssignmentExport,
  exportResolvedEntityAssignments,
} from "./entity-assignment-export";
import { holdoverWriteOutboxName } from "./holdover-write-outbox-core";

export interface AssignmentWriterNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  };
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
  writers: AssignmentWriterNamespace,
  outboxes: AssignmentWriterNamespace,
  saltStore: SaltStore,
  input: { appId: string; idType: string; targetingKey: string },
  _logger?: AssignmentStoreLogger,
): Promise<EntityAssignmentExport> {
  const identity = await resolveEntityPrivacyIdentity(saltStore, input);
  return exportResolvedEntityAssignments(kv, writers, outboxes, identity);
}

export async function deleteEntityAssignments(
  writers: AssignmentWriterNamespace,
  outboxes: AssignmentWriterNamespace,
  saltStore: SaltStore,
  input: { appId: string; idType: string; targetingKey: string },
  deleteBeforeTs: string,
): Promise<EntityAssignmentDeleteResult> {
  const identity = await resolveEntityPrivacyIdentity(saltStore, input);
  return deleteResolvedEntityAssignments(writers, outboxes, identity, deleteBeforeTs);
}

export async function deleteResolvedEntityAssignments(
  writers: AssignmentWriterNamespace,
  outboxes: AssignmentWriterNamespace,
  identity: EntityPrivacyIdentity,
  deleteBeforeTs: string,
): Promise<EntityAssignmentDeleteResult> {
  const proofs = [];
  for (const targetingKeyHash of identity.targetingKeyHashes) {
    proofs.push(
      await deleteAssignmentWriter(writers, identity, targetingKeyHash, deleteBeforeTs),
      await deleteHoldoverOutbox(outboxes, identity, targetingKeyHash, deleteBeforeTs),
    );
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
  const result = (await response.json()) as { ok?: unknown; remainingJobs?: unknown };
  if (result.ok !== true || result.remainingJobs !== false) {
    throw new Error("Holdover write outbox delete returned an invalid proof");
  }
  return `${targetingKeyHash}:holdover-write-outbox-suppressed-and-purged-v1`;
}

async function deleteAssignmentWriter(
  writers: AssignmentWriterNamespace,
  input: { appId: string; idType: string },
  targetingKeyHash: string,
  deleteBeforeTs: string,
): Promise<string> {
  const name = assignmentWriterName({
    appId: input.appId,
    idType: input.idType,
    targetingKeyHash,
  });
  const writer = writers.get(writers.idFromName(name));
  const response = await writer.fetch("https://assignment-store.internal/delete", {
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
    throw new Error(`Assignment writer delete failed with HTTP ${response.status}`);
  }
  const result = (await response.json()) as { deleted?: unknown; proof?: unknown };
  if (result.deleted !== true || typeof result.proof !== "string" || result.proof.length === 0) {
    throw new Error("Assignment writer delete returned an invalid proof");
  }
  return `${targetingKeyHash}:${result.proof}`;
}
