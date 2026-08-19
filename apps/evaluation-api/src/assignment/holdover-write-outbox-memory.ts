import type { HashedAssignmentPutInput } from "./assignment-store";
import type { HoldoverWriteCoordinator } from "./holdover-write-outbox";
import {
  deleteEntityOutbox,
  ensureHoldoverWriteJob,
  HOLDOVER_WRITE_JOB_PREFIX,
  type HoldoverWriteEnsureResult,
  type HoldoverWriteJob,
  type HoldoverWriteOutboxLogger,
  type HoldoverWriteOutboxStorage,
  type HoldoverWritePutPort,
  type HoldoverWriteSuppressionPort,
  holdoverWriteOutboxName,
  purgeEntityOutboxState,
  runHoldoverWriteAlarm,
  suppressEntityOutbox,
} from "./holdover-write-outbox-core";

/** In-memory outbox for tests that need failure-then-retry without Miniflare. */
export class MemoryHoldoverWriteCoordinator implements HoldoverWriteCoordinator {
  private readonly entities = new Map<string, Map<string, unknown>>();
  private appSuppressed = new Set<string>();

  constructor(
    private readonly putPort: HoldoverWritePutPort,
    private readonly logger?: HoldoverWriteOutboxLogger,
    private readonly now: () => number = () => Date.now(),
  ) {}

  ensure(
    input: HashedAssignmentPutInput,
    options?: { sourceCreatedAtMs?: number },
  ): Promise<HoldoverWriteEnsureResult> {
    return ensureHoldoverWriteJob(
      this.storageFor(input),
      this.putPort,
      input,
      this.now(),
      this.logger,
      this.suppressionPort(),
      options,
    );
  }

  /** Drive one alarm tick for the Entity outbox (test seam). */
  alarm(input: HashedAssignmentPutInput): Promise<void> {
    return runHoldoverWriteAlarm(
      this.storageFor(input),
      this.putPort,
      this.now(),
      this.logger,
      this.suppressionPort(),
    );
  }

  suppressEntity(input: HashedAssignmentPutInput, deleteBeforeTsMs: number): Promise<void> {
    return suppressEntityOutbox(this.storageFor(input), deleteBeforeTsMs);
  }

  purgeEntity(
    input: HashedAssignmentPutInput,
    deleteBeforeTsMs: number = Number.POSITIVE_INFINITY,
  ): Promise<void> {
    return purgeEntityOutboxState(this.storageFor(input), deleteBeforeTsMs);
  }

  deleteEntity(input: HashedAssignmentPutInput, deleteBeforeTsMs: number): Promise<void> {
    return deleteEntityOutbox(this.storageFor(input), deleteBeforeTsMs);
  }

  suppressApp(appId: string): void {
    this.appSuppressed.add(appId);
  }

  jobFor(input: HashedAssignmentPutInput): HoldoverWriteJob | undefined {
    const bucket = this.entities.get(holdoverWriteOutboxName(input));
    return bucket?.get(`${HOLDOVER_WRITE_JOB_PREFIX}${input.experimentId}`) as
      | HoldoverWriteJob
      | undefined;
  }

  private suppressionPort(): HoldoverWriteSuppressionPort {
    return {
      isAppSuppressed: async (appId) => this.appSuppressed.has(appId),
    };
  }

  private storageFor(input: HashedAssignmentPutInput): HoldoverWriteOutboxStorage {
    const entity = holdoverWriteOutboxName(input);
    let bucket = this.entities.get(entity);
    if (bucket === undefined) {
      bucket = new Map();
      this.entities.set(entity, bucket);
    }
    const store = bucket;
    return {
      async get<T>(key: string): Promise<T | undefined> {
        return store.get(key) as T | undefined;
      },
      async put(key, value) {
        store.set(key, value);
      },
      async delete(key): Promise<boolean | undefined> {
        const had = store.has(key);
        store.delete(key);
        return had;
      },
      async list<T>(options?: { prefix?: string }): Promise<Map<string, T>> {
        const out = new Map<string, T>();
        for (const [key, value] of store) {
          if (options?.prefix === undefined || key.startsWith(options.prefix)) {
            out.set(key, value as T);
          }
        }
        return out;
      },
      async setAlarm() {},
      async deleteAlarm() {},
    };
  }
}
