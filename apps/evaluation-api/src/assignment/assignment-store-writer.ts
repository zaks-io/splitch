import { assignmentKey } from "@splitch/contracts";
import type { AssignmentStoreEntry } from "./assignment-store";
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

export interface AssignmentWriterStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

export type WaitUntil = (promise: Promise<unknown>) => void;

interface StoredAssignment extends HashedAssignmentPutInput {}

export class AssignmentStoreWriter {
  constructor(
    private readonly storage: AssignmentWriterStorage,
    private readonly kv: AssignmentKv,
    private readonly waitUntil: WaitUntil,
  ) {}

  async put(input: HashedAssignmentPutInput): Promise<AssignmentStorePutResult> {
    const storageKey = `${STORAGE_KEY_PREFIX}${input.experimentId}`;
    const existing = await this.storage.get<StoredAssignment>(storageKey);
    if (existing !== undefined) {
      // Self-healing: DO storage is the winner record, but reads go through the
      // entity KV blob. Re-assert the KV entry (idempotent merge, no-op put when
      // already present) so a write-through that failed once is retried on the
      // next put instead of leaving the holdover invisible forever.
      this.waitUntil(this.writeThrough(existing));
      return { status: "existing", assignment: entryFrom(existing) };
    }

    await this.storage.put(storageKey, input);
    this.waitUntil(this.writeThrough(input));
    return { status: "stored", assignment: entryFrom(input) };
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
