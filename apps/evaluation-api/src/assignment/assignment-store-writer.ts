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
const ENTITY_DELETED_KEY = "privacy:entity-deleted";

export interface AssignmentWriterStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
  deleteAll?(): Promise<void>;
}

export type WaitUntil = (promise: Promise<unknown>) => void;

interface StoredAssignment extends HashedAssignmentPutInput {}

export interface AssignmentWriterExport {
  assignments: AssignmentStoreValue;
  tombstoned: boolean;
  proof: "assignment-do-winners-exported-v1";
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
    if ((await this.storage.get<boolean>(ENTITY_DELETED_KEY)) === true) {
      throw new Error("assignment-store: Entity assignments are deleted");
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

  async deleteEntity(): Promise<string> {
    if (this.storage.deleteAll === undefined) {
      throw new Error("assignment-store: Durable Object deleteAll is unavailable");
    }
    await this.storage.deleteAll();
    await this.storage.put(ENTITY_DELETED_KEY, true);
    return "assignment-do-tombstone-v1";
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
      tombstoned: (await this.storage.get<boolean>(ENTITY_DELETED_KEY)) === true,
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
}

function entryFrom(input: Pick<StoredAssignment, "runId" | "variant">): AssignmentStoreEntry {
  return { runId: input.runId, variant: input.variant };
}
