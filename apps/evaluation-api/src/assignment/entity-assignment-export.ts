import { assignmentKey, assignmentWriterName } from "@splitch/contracts";
import type { EntityPrivacyIdentity } from "@splitch/privacy";
import type { AssignmentStoreLogger, AssignmentStoreValue } from "./assignment-store";
import { readAssignmentValue } from "./assignment-store";
import type { AssignmentWriterNamespace } from "./entity-assignment-privacy";
import type {
  EntityHoldoverWriteSuppression,
  HoldoverWriteJob,
} from "./holdover-write-outbox-core";
import { holdoverWriteOutboxName } from "./holdover-write-outbox-core";

export interface EntityAssignmentExport {
  appId: string;
  idType: string;
  targetingKeyHashes: readonly string[];
  entityFamilyHash: string;
  records: readonly {
    targetingKeyHash: string;
    assignments: AssignmentStoreValue;
    assignmentWriterAssignments: AssignmentStoreValue;
    holdoverWrites: readonly HoldoverWriteJob[];
    holdoverSuppression: EntityHoldoverWriteSuppression | null;
  }[];
  proofs: readonly string[];
  nextCursor?: string | null;
}

export async function exportEntityAssignmentsPage(
  kv: Parameters<typeof readAssignmentValue>[0],
  writers: AssignmentWriterNamespace,
  outboxes: AssignmentWriterNamespace,
  identity: EntityPrivacyIdentity,
  cursor: string | null,
  limit: number,
  logger?: AssignmentStoreLogger,
): Promise<EntityAssignmentExport & { nextCursor: string | null }> {
  const start = cursor === null ? 0 : Number(cursor);
  if (!Number.isSafeInteger(start) || start < 0 || start > identity.targetingKeyHashes.length) {
    throw new Error("entity assignment privacy cursor is invalid");
  }
  const end = Math.min(start + limit, identity.targetingKeyHashes.length);
  const exported = await exportResolvedEntityAssignments(
    kv,
    writers,
    outboxes,
    { ...identity, targetingKeyHashes: identity.targetingKeyHashes.slice(start, end) },
    logger,
  );
  return {
    ...exported,
    targetingKeyHashes: identity.targetingKeyHashes,
    entityFamilyHash: identity.entityFamilyHash,
    nextCursor: end < identity.targetingKeyHashes.length ? String(end) : null,
  };
}

export async function exportResolvedEntityAssignments(
  kv: Parameters<typeof readAssignmentValue>[0],
  writers: AssignmentWriterNamespace,
  outboxes: AssignmentWriterNamespace,
  identity: EntityPrivacyIdentity,
  logger?: AssignmentStoreLogger,
): Promise<EntityAssignmentExport> {
  const records = [];
  const proofs = [];
  for (const targetingKeyHash of identity.targetingKeyHashes) {
    const assignments = await readAssignmentValue(
      kv,
      assignmentKey(identity.appId, identity.idType, targetingKeyHash),
      logger,
    );
    const writerExport = await exportAssignmentWriter(writers, identity, targetingKeyHash);
    const outbox = outboxes.get(
      outboxes.idFromName(holdoverWriteOutboxName({ ...identity, targetingKeyHash })),
    );
    const response = await outbox.fetch("https://holdover-write-outbox.internal/export");
    if (!response.ok)
      throw new Error(`Holdover write outbox export failed with HTTP ${response.status}`);
    const holdover = parseHoldoverExport(await response.json());
    proofs.push(
      `${targetingKeyHash}:${writerExport.proof}`,
      `${targetingKeyHash}:assignment-and-holdover-exported-v1`,
    );
    if (
      Object.keys(assignments).length > 0 ||
      Object.keys(writerExport.assignments).length > 0 ||
      holdover.jobs.length > 0 ||
      holdover.suppression
    ) {
      records.push({
        targetingKeyHash,
        assignments,
        assignmentWriterAssignments: writerExport.assignments,
        holdoverWrites: holdover.jobs,
        holdoverSuppression: holdover.suppression,
      });
    }
  }
  return { ...exportedIdentity(identity, records), proofs };
}

async function exportAssignmentWriter(
  writers: AssignmentWriterNamespace,
  input: { appId: string; idType: string },
  targetingKeyHash: string,
): Promise<{ assignments: AssignmentStoreValue; proof: "assignment-do-winners-exported-v1" }> {
  const response = await writers
    .get(writers.idFromName(assignmentWriterName({ ...input, targetingKeyHash })))
    .fetch("https://assignment-store.internal/export");
  if (!response.ok) throw new Error(`Assignment writer export failed with HTTP ${response.status}`);
  const body = (await response.json()) as {
    assignments?: unknown;
    tombstoned?: unknown;
    proof?: unknown;
  };
  if (
    !isAssignmentStoreValue(body.assignments) ||
    typeof body.tombstoned !== "boolean" ||
    body.proof !== "assignment-do-winners-exported-v1"
  )
    throw new Error("Assignment writer export returned an invalid proof");
  return { assignments: body.assignments, proof: body.proof };
}

function isAssignmentStoreValue(value: unknown): value is AssignmentStoreValue {
  if (!isRecord(value)) return false;
  return Object.values(value).every(
    (entry) =>
      isRecord(entry) &&
      typeof entry.runId === "string" &&
      entry.runId.length > 0 &&
      typeof entry.variant === "string" &&
      entry.variant.length > 0,
  );
}

function parseHoldoverExport(value: unknown): {
  jobs: HoldoverWriteJob[];
  suppression: EntityHoldoverWriteSuppression | null;
} {
  if (
    !isRecord(value) ||
    !Array.isArray(value.jobs) ||
    !(value.suppression === null || isSuppression(value.suppression))
  ) {
    throw new Error("Holdover write outbox export returned an invalid body");
  }
  return { jobs: value.jobs as HoldoverWriteJob[], suppression: value.suppression };
}

function isSuppression(value: unknown): value is EntityHoldoverWriteSuppression {
  return isRecord(value) && typeof value.deleteBeforeTsMs === "number";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exportedIdentity(
  identity: EntityPrivacyIdentity,
  records: EntityAssignmentExport["records"],
): Omit<EntityAssignmentExport, "proofs"> {
  return { ...identity, records };
}
