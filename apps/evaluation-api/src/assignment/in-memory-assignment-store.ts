import { assignmentKey } from "@splitch/contracts";
import type { SaltStore } from "@splitch/privacy";
import {
  type AssignmentPutInput,
  type AssignmentStore,
  type AssignmentStoreEntry,
  type AssignmentStorePutResult,
  assignmentValueToMap,
  assignmentWriterName,
  type HashedAssignmentPutInput,
  hashedAssignmentIdentity,
  mergeAssignmentValue,
  mergeRetainedAssignmentValues,
  retainedAssignmentIdentities,
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
    const identities = await retainedAssignmentIdentities(this.saltStore, input);
    const values = [];
    for (const { entityKey } of identities) {
      this.entityKeyNames.push(entityKey);
      values.push(this.entityValues.get(entityKey) ?? {});
    }
    return assignmentValueToMap(mergeRetainedAssignmentValues(values));
  }

  async put(input: AssignmentPutInput): Promise<AssignmentStorePutResult> {
    const existing = (await this.getAll(input)).get(input.experimentId);
    if (existing !== undefined) {
      return { status: "existing", assignment: existing };
    }
    const { targetingKeyHash } = await hashedAssignmentIdentity(this.saltStore, input);
    return this.putHashed({
      appId: input.appId,
      experimentId: input.experimentId,
      idType: input.idType,
      targetingKeyHash,
      runId: input.runId,
      variant: input.variant,
    });
  }

  async putHashed(input: HashedAssignmentPutInput): Promise<AssignmentStorePutResult> {
    const entityKey = assignmentKey(input.appId, input.idType, input.targetingKeyHash);
    const writerName = assignmentWriterName(input);
    this.entityKeyNames.push(entityKey);
    this.writerObjectNames.push(writerName);

    // Mirrors the real writer: serialization is per ENTITY (the writer DO name),
    // while the first-touch winner is recorded per (entity, experiment).
    const winnerKey = `${writerName}${input.experimentId}`;
    return this.withLock(writerName, async () => {
      const existing = this.writerValues.get(winnerKey);
      if (existing !== undefined) {
        return { status: "existing", assignment: existing };
      }

      const assignment = { runId: input.runId, variant: input.variant };
      this.writerValues.set(winnerKey, assignment);
      const current = this.entityValues.get(entityKey) ?? {};
      this.entityValues.set(
        entityKey,
        mergeAssignmentValue(current, {
          experimentId: input.experimentId,
          runId: input.runId,
          variant: input.variant,
        }),
      );
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
