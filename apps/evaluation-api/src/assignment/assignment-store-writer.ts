import { assignmentKey } from "@splitch/contracts";
import type { AssignmentStoreEntry, AssignmentStoreValue } from "./assignment-store";
import {
  type AssignmentKv,
  type AssignmentStorePutResult,
  type HashedAssignmentPutInput,
  mergeAssignmentValue,
  readAssignmentValue,
  serializeAssignmentValue,
} from "./assignment-store";

// The DO is per-ENTITY (assignmentWriterName), so storage keys carry the
// experimentId: one entity can hold a first-touch winner per Experiment.
const STORAGE_KEY_PREFIX = "assignment:";
const ENTITY_DELETION_CUTOFF_KEY = "privacy:entity-deletion-cutoff";

export interface AssignmentWriterStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean | undefined>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
}

export type WaitUntil = (promise: Promise<unknown>) => void;

interface StoredAssignment extends HashedAssignmentPutInput {}

export interface AssignmentWriterExport {
  assignments: AssignmentStoreValue;
  tombstoned: boolean;
  proof: "assignment-do-winners-exported-v1";
}

interface EntityDeletionCutoff {
  readonly deleteBeforeTsMs: number;
}

export class AssignmentStoreWriter {
  constructor(
    private readonly storage: AssignmentWriterStorage,
    private readonly kv: AssignmentKv,
    /** Retained for call-site compatibility; put awaits write-through so HTTP
     * success means the Entity KV blob is visible (SPL-346 completion rule). */
    waitUntil: WaitUntil,
  ) {
    void waitUntil;
  }

  async put(input: HashedAssignmentPutInput): Promise<AssignmentStorePutResult> {
    if (input.sourceCreatedAtMs === undefined || !Number.isFinite(input.sourceCreatedAtMs)) {
      throw new Error("assignment-store: sourceCreatedAtMs is required");
    }
    const cutoff = await this.storage.get<EntityDeletionCutoff>(ENTITY_DELETION_CUTOFF_KEY);
    if (cutoff !== undefined && input.sourceCreatedAtMs <= cutoff.deleteBeforeTsMs) {
      throw new Error("assignment-store: Assignment predates Entity deletion cutoff");
    }
    const storageKey = `${STORAGE_KEY_PREFIX}${input.experimentId}`;
    const existing = await this.storage.get<StoredAssignment>(storageKey);
    if (existing !== undefined) {
      // Self-healing: DO storage is the winner record, but reads go through the
      // entity KV blob. Re-assert the KV entry (idempotent merge, no-op put when
      // already present) so a write-through that failed once is retried on the
      // next put instead of leaving the holdover invisible forever.
      await this.writeThrough(existing);
      return { status: "existing", assignment: entryFrom(existing) };
    }

    await this.storage.put(storageKey, input);
    await this.writeThrough(input);
    return { status: "stored", assignment: entryFrom(input) };
  }

  async deleteEntity(
    identity: Pick<HashedAssignmentPutInput, "appId" | "idType" | "targetingKeyHash">,
    deleteBeforeTsMs: number,
  ): Promise<string> {
    if (!Number.isFinite(deleteBeforeTsMs)) {
      throw new Error("assignment-store: deleteBeforeTsMs must be finite");
    }
    const previous = await this.storage.get<EntityDeletionCutoff>(ENTITY_DELETION_CUTOFF_KEY);
    const cutoff = Math.max(
      previous?.deleteBeforeTsMs ?? Number.NEGATIVE_INFINITY,
      deleteBeforeTsMs,
    );
    const stored = await this.storage.list<StoredAssignment>({ prefix: STORAGE_KEY_PREFIX });
    for (const [key, assignment] of stored) {
      if (assignment.sourceCreatedAtMs === undefined || assignment.sourceCreatedAtMs <= cutoff) {
        await this.storage.delete(key);
      }
    }
    await this.storage.put(ENTITY_DELETION_CUTOFF_KEY, { deleteBeforeTsMs: cutoff });
    await this.rewriteKvFromDurableWinners(identity);
    return "assignment-do-cutoff-tombstone-v2";
  }

  async exportEntity(): Promise<AssignmentWriterExport> {
    const stored = await this.storage.list<StoredAssignment>({ prefix: STORAGE_KEY_PREFIX });
    const assignments: AssignmentStoreValue = {};
    for (const [key, assignment] of stored) {
      const experimentId = key.slice(STORAGE_KEY_PREFIX.length);
      if (!experimentId || assignment.experimentId !== experimentId) {
        throw new Error("assignment-store: durable winner key is invalid");
      }
      assignments[experimentId] = entryFrom(assignment);
    }
    return {
      assignments,
      tombstoned:
        (await this.storage.get<EntityDeletionCutoff>(ENTITY_DELETION_CUTOFF_KEY)) !== undefined,
      proof: "assignment-do-winners-exported-v1",
    };
  }

  private async writeThrough(input: HashedAssignmentPutInput): Promise<void> {
    const key = assignmentKey(input.appId, input.idType, input.targetingKeyHash);
    const current = await readAssignmentValue(this.kv, key);
    const next = mergeAssignmentValue(current, input);
    if (next === current) {
      return; // already visible in KV — nothing to re-assert
    }
    await this.kv.put(key, serializeAssignmentValue(next));
  }

  private async rewriteKvFromDurableWinners(
    identity: Pick<HashedAssignmentPutInput, "appId" | "idType" | "targetingKeyHash">,
  ): Promise<void> {
    if (this.kv.delete === undefined) {
      throw new Error("assignment-store: Assignment KV delete is unavailable");
    }
    const stored = await this.storage.list<StoredAssignment>({ prefix: STORAGE_KEY_PREFIX });
    let value: AssignmentStoreValue = {};
    for (const assignment of stored.values()) value = mergeAssignmentValue(value, assignment);
    const key = assignmentKey(identity.appId, identity.idType, identity.targetingKeyHash);
    if (Object.keys(value).length === 0) await this.kv.delete(key);
    else await this.kv.put(key, serializeAssignmentValue(value));
  }
}

function entryFrom(input: Pick<StoredAssignment, "runId" | "variant">): AssignmentStoreEntry {
  return { runId: input.runId, variant: input.variant };
}
