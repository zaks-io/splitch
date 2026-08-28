import { assignmentKey } from "@splitch/contracts";
import {
  type EntityPrivacyIdentity,
  resolveEntityPrivacyIdentity,
  type SaltStore,
} from "@splitch/privacy";
import type { AssignmentKv, AssignmentStoreLogger, AssignmentStoreValue } from "./assignment-store";
import { readAssignmentValue } from "./assignment-store";

export interface EntityAssignmentExport {
  appId: string;
  idType: string;
  targetingKeyHashes: readonly string[];
  records: readonly {
    targetingKeyHash: string;
    assignments: AssignmentStoreValue;
  }[];
}

export interface EntityAssignmentDeleteResult {
  appId: string;
  idType: string;
  targetingKeyHashes: readonly string[];
  deletedKeyCount: number;
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
  saltStore: SaltStore,
  input: { appId: string; idType: string; targetingKey: string },
): Promise<EntityAssignmentDeleteResult> {
  if (kv.delete === undefined) {
    throw new Error("Assignment KV delete is unavailable");
  }
  const identity = await resolveEntityPrivacyIdentity(saltStore, input);
  let deletedKeyCount = 0;
  for (const targetingKeyHash of identity.targetingKeyHashes) {
    await kv.delete(assignmentKey(input.appId, input.idType, targetingKeyHash));
    deletedKeyCount += 1;
  }
  return {
    appId: identity.appId,
    idType: identity.idType,
    targetingKeyHashes: identity.targetingKeyHashes,
    deletedKeyCount,
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
    records,
  };
}
