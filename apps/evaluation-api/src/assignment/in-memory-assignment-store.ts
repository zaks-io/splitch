import type { SaltStore } from "@splitch/privacy";
import {
  type AssignmentPutInput,
  type AssignmentStore,
  type AssignmentStoreEntry,
  type AssignmentStorePutResult,
  assignmentValueToMap,
  assignmentWriterName,
  hashedAssignmentIdentity,
  mergeAssignmentValue,
} from "./assignment-store";

export class InMemoryAssignmentStore implements AssignmentStore {
  private readonly entityValues = new Map<string, Record<string, AssignmentStoreEntry>>();
  private readonly writerValues = new Map<string, AssignmentStoreEntry>();
  private readonly locks = new Map<string, Promise<void>>();
  readonly entityKeyNames: string[] = [];
  readonly writerObjectNames: string[] = [];
  readonly policyCalls: string[] = [];

  constructor(private readonly saltStore: SaltStore) {}

  async getAll(input: Parameters<AssignmentStore["getAll"]>[0]) {
    const { entityKey } = await hashedAssignmentIdentity(this.saltStore, input);
    this.entityKeyNames.push(entityKey);
    return assignmentValueToMap(this.entityValues.get(entityKey) ?? {});
  }

  async put(input: AssignmentPutInput): Promise<AssignmentStorePutResult> {
    const { entityKey, targetingKeyHash } = await hashedAssignmentIdentity(this.saltStore, input);
    const writerName = assignmentWriterName({ ...input, targetingKeyHash });
    this.entityKeyNames.push(entityKey);
    this.writerObjectNames.push(writerName);

    return this.withLock(writerName, async () => {
      const existing = this.writerValues.get(writerName);
      if (existing !== undefined) {
        return { status: "existing", assignment: existing };
      }

      const assignment = { runId: input.runId, variant: input.variant };
      this.writerValues.set(writerName, assignment);
      const current = this.entityValues.get(entityKey) ?? {};
      this.entityValues.set(entityKey, mergeAssignmentValue(current, input));
      return { status: "stored", assignment };
    });
  }

  private async withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => next);
    this.locks.set(key, queued);
    await previous;

    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(key) === queued) {
        this.locks.delete(key);
      }
    }
  }
}
