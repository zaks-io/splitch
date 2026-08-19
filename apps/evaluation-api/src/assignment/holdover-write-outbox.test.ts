import { describe, expect, it } from "vitest";
import type { HashedAssignmentPutInput } from "./assignment-store";
import {
  DirectHoldoverWriteCoordinator,
  MemoryHoldoverWriteCoordinator,
} from "./holdover-write-outbox";
import {
  ensureHoldoverWriteJob,
  HOLDOVER_WRITE_JOB_KEY,
  HOLDOVER_WRITE_MAX_ATTEMPTS,
  type HoldoverWriteJob,
  type HoldoverWriteOutboxStorage,
  holdoverWriteOutboxName,
  holdoverWriteRetryDelayMs,
  scopedHoldoverWriteLog,
} from "./holdover-write-outbox-core";

const basePut: HashedAssignmentPutInput = {
  appId: "app-A",
  experimentId: "exp-1",
  idType: "user",
  targetingKeyHash: "hash-abc",
  runId: "run-42",
  variant: "treatment",
};

class FailNTimesPut {
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

class MemoryStorage implements HoldoverWriteOutboxStorage {
  job: HoldoverWriteJob | undefined;
  alarms: number[] = [];
  async get<T>(key: string): Promise<T | undefined> {
    if (key !== HOLDOVER_WRITE_JOB_KEY) return undefined;
    return this.job as T | undefined;
  }
  async put<T>(key: string, value: T): Promise<void> {
    if (key === HOLDOVER_WRITE_JOB_KEY) this.job = value as HoldoverWriteJob;
  }
  async delete(key: string): Promise<boolean | undefined> {
    if (key === HOLDOVER_WRITE_JOB_KEY) {
      const had = this.job !== undefined;
      this.job = undefined;
      return had;
    }
    return false;
  }
  async setAlarm(scheduledTime: number): Promise<void> {
    this.alarms.push(scheduledTime);
  }
  async deleteAlarm(): Promise<void> {}
}

describe("holdover write outbox core", () => {
  it("names the outbox with only pseudonymous identity fields", () => {
    expect(holdoverWriteOutboxName(basePut)).toBe("app-A\u001fuser\u001fhash-abc\u001fexp-1");
    expect(holdoverWriteOutboxName(basePut)).not.toMatch(/ticket|credential|targetingKey[^H]/i);
  });

  it("logs scoped identifiers without truncating actionable fields", () => {
    const log = scopedHoldoverWriteLog({
      ...basePut,
      attempt: 3,
      status: "pending",
    });
    expect(log).toEqual({
      appId: "app-A",
      experimentId: "exp-1",
      idType: "user",
      targetingKeyHash: "hash-abc",
      runId: "run-42",
      variant: "treatment",
      attempt: 3,
      status: "pending",
    });
  });

  it("completes on the first successful put without scheduling an alarm", async () => {
    const put = new FailNTimesPut(0);
    const storage = new MemoryStorage();
    const result = await ensureHoldoverWriteJob(storage, put, basePut, 1_000);
    expect(result).toEqual({ status: "completed" });
    expect(put.calls).toHaveLength(1);
    expect(storage.alarms).toEqual([]);
    expect(storage.job?.status).toBe("completed");
  });

  it("owns retry work when the first put fails and retries on alarm", async () => {
    const put = new FailNTimesPut(1);
    const storage = new MemoryStorage();
    const logs: Array<{ message: string; detail: unknown }> = [];
    const result = await ensureHoldoverWriteJob(storage, put, basePut, 1_000, {
      error(message, detail) {
        logs.push({ message, detail });
      },
    });
    expect(result).toEqual({ status: "owned" });
    expect(put.calls).toHaveLength(1);
    expect(storage.job?.status).toBe("pending");
    expect(storage.alarms).toEqual([1_000 + holdoverWriteRetryDelayMs(1)]);
    expect(logs[0]?.message).toBe("holdover_write_put_failed_owned_for_retry");

    const retry = await ensureHoldoverWriteJob(storage, put, basePut, 2_000);
    expect(retry).toEqual({ status: "completed" });
    expect(put.calls).toHaveLength(2);
    expect(storage.job?.status).toBe("completed");
  });

  it("duplicate ensure delivery remains idempotent through putIfAbsent-style puts", async () => {
    const put = new FailNTimesPut(0);
    const storage = new MemoryStorage();
    await ensureHoldoverWriteJob(storage, put, basePut, 1_000);
    const second = await ensureHoldoverWriteJob(storage, put, basePut, 2_000);
    expect(second).toEqual({ status: "completed" });
    // Second ensure short-circuits on completed status — no second put.
    expect(put.calls).toHaveLength(1);
  });

  it("marks poisoned and logs exhaustion after max attempts", async () => {
    const put = new FailNTimesPut(HOLDOVER_WRITE_MAX_ATTEMPTS + 5);
    const storage = new MemoryStorage();
    const logs: Array<{ message: string; detail: Record<string, unknown> }> = [];
    let now = 1_000;
    let status = await ensureHoldoverWriteJob(storage, put, basePut, now, {
      error(message, detail) {
        logs.push({ message, detail: detail as Record<string, unknown> });
      },
    });
    expect(status).toEqual({ status: "owned" });
    for (let i = 0; i < HOLDOVER_WRITE_MAX_ATTEMPTS - 1; i += 1) {
      now += 10_000;
      status = await ensureHoldoverWriteJob(storage, put, basePut, now, {
        error(message, detail) {
          logs.push({ message, detail: detail as Record<string, unknown> });
        },
      });
    }
    expect(status).toEqual({ status: "poisoned" });
    expect(storage.job?.status).toBe("poisoned");
    expect(storage.job?.attempt).toBe(HOLDOVER_WRITE_MAX_ATTEMPTS);
    const exhaustion = logs.find((entry) => entry.message === "holdover_write_retry_exhausted");
    expect(exhaustion?.detail).toMatchObject({
      appId: "app-A",
      experimentId: "exp-1",
      targetingKeyHash: "hash-abc",
      runId: "run-42",
      variant: "treatment",
      status: "poisoned",
      attempt: HOLDOVER_WRITE_MAX_ATTEMPTS,
    });
    expect(JSON.stringify(exhaustion?.detail)).not.toMatch(/ticket|pk_|sk_|raw.?targeting/i);
  });
});

describe("HoldoverWriteCoordinator adapters", () => {
  it("DirectHoldoverWriteCoordinator rejects when put fails (no durable ownership)", async () => {
    const put = new FailNTimesPut(1);
    const coordinator = new DirectHoldoverWriteCoordinator(put);
    await expect(coordinator.ensure(basePut)).rejects.toThrow(/forced put failure/);
  });

  it("MemoryHoldoverWriteCoordinator owns then completes on alarm", async () => {
    const put = new FailNTimesPut(1);
    const coordinator = new MemoryHoldoverWriteCoordinator(put);
    await expect(coordinator.ensure(basePut)).resolves.toEqual({ status: "owned" });
    await coordinator.alarm(basePut);
    await expect(coordinator.ensure(basePut)).resolves.toEqual({ status: "completed" });
    expect(put.calls).toHaveLength(2);
  });
});
