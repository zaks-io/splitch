import type { HashedAssignmentPutInput } from "./assignment-store";
import {
  type HoldoverWriteJob,
  type HoldoverWriteOutboxStorage,
  holdoverWriteJobKey,
} from "./holdover-write-outbox-core";

export const basePut: HashedAssignmentPutInput = {
  appId: "app-A",
  experimentId: "exp-1",
  idType: "user",
  targetingKeyHash: "v1:hash-abc",
  identityVersion: "v1",
  runId: "run-42",
  variant: "treatment",
};

export class FailNTimesPut {
  readonly calls: HashedAssignmentPutInput[] = [];
  constructor(private readonly failures: number) {}
  async putHashed(input: HashedAssignmentPutInput): Promise<{ status: "stored" }> {
    this.calls.push(input);
    if (this.calls.length <= this.failures) {
      throw new Error(`forced put failure #${this.calls.length}`);
    }
    return { status: "stored" };
  }
}

export class MemoryStorage implements HoldoverWriteOutboxStorage {
  readonly values = new Map<string, unknown>();
  alarms: number[] = [];
  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }
  async delete(key: string): Promise<boolean | undefined> {
    const had = this.values.has(key);
    this.values.delete(key);
    return had;
  }
  async list<T>(options?: { prefix?: string }): Promise<Map<string, T>> {
    const out = new Map<string, T>();
    for (const [key, value] of this.values) {
      if (options?.prefix === undefined || key.startsWith(options.prefix)) {
        out.set(key, value as T);
      }
    }
    return out;
  }
  async setAlarm(scheduledTime: number): Promise<void> {
    this.alarms.push(scheduledTime);
  }
  async deleteAlarm(): Promise<void> {}
  get job(): HoldoverWriteJob | undefined {
    return this.values.get(holdoverWriteJobKey(basePut.experimentId)) as
      | HoldoverWriteJob
      | undefined;
  }
}
