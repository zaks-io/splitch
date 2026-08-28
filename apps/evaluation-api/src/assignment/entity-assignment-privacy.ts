import { assignmentKey } from "@splitch/contracts";
import {
  type EntityPrivacyIdentity,
  resolveEntityPrivacyIdentity,
  type SaltStore,
} from "@splitch/privacy";
import type { AssignmentKv, AssignmentStoreLogger, AssignmentStoreValue } from "./assignment-store";
import { assignmentWriterName, readAssignmentValue } from "./assignment-store";

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
  }[];
}

export interface EntityAssignmentDeleteResult {
  appId: string;
  idType: string;
  targetingKeyHashes: readonly string[];
  entityFamilyHash: string;
  deletedKeyCount: number;
  deletedWriterCount: number;
  proofs: readonly string[];
}

export async function exportEntityAssignments(
  kv: AssignmentKv,
  saltStore: SaltStore,
  input: { appId: string; idType: string; targetingKey: string },
  logger?: AssignmentStoreLogger,
): Promise<EntityAssignmentExport> {
  const identity = await resolveEntityPrivacyIdentity(saltStore, input);
  const records = [];
  for (const targetingKeyHash of identity.targetingKeyHashes) {
    const assignments = await readAssignmentValue(
      kv,
      assignmentKey(input.appId, input.idType, targetingKeyHash),
      logger,
    );
    if (Object.keys(assignments).length > 0) {
      records.push({ targetingKeyHash, assignments });
    }
  }
  return exportedIdentity(identity, records);
}

export async function deleteEntityAssignments(
  kv: AssignmentKv,
  writers: AssignmentWriterNamespace,
  saltStore: SaltStore,
  input: { appId: string; idType: string; targetingKey: string },
): Promise<EntityAssignmentDeleteResult> {
  if (kv.delete === undefined) {
    throw new Error("Assignment KV delete is unavailable");
  }
  const identity = await resolveEntityPrivacyIdentity(saltStore, input);
  let deletedKeyCount = 0;
  const proofs = [];
  for (const targetingKeyHash of identity.targetingKeyHashes) {
    const writerName = assignmentWriterName({
      appId: input.appId,
      idType: input.idType,
      targetingKeyHash,
    });
    const writer = writers.get(writers.idFromName(writerName));
    const response = await writer.fetch("https://assignment-store.internal/delete", {
      method: "POST",
    });
    if (!response.ok)
      throw new Error(`Assignment writer delete failed with HTTP ${response.status}`);
    const result = (await response.json()) as { deleted?: unknown; proof?: unknown };
    if (result.deleted !== true || typeof result.proof !== "string" || result.proof.length === 0) {
      throw new Error("Assignment writer delete returned an invalid proof");
    }
    proofs.push(`${targetingKeyHash}:${result.proof}`);
    await kv.delete(assignmentKey(input.appId, input.idType, targetingKeyHash));
    deletedKeyCount += 1;
  }
  return {
    appId: identity.appId,
    idType: identity.idType,
    targetingKeyHashes: identity.targetingKeyHashes,
    entityFamilyHash: identity.entityFamilyHash,
    deletedKeyCount,
    deletedWriterCount: proofs.length,
    proofs,
  };
}

function exportedIdentity(
  identity: EntityPrivacyIdentity,
  records: EntityAssignmentExport["records"],
): EntityAssignmentExport {
  return {
    appId: identity.appId,
    idType: identity.idType,
    targetingKeyHashes: identity.targetingKeyHashes,
    entityFamilyHash: identity.entityFamilyHash,
    records,
  };
}
