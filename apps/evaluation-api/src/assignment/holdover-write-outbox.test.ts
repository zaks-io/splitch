import { describe, expect, it } from "vitest";
import { RecordingKv } from "./assignment-store-test-fixtures";
import {
  suppressAndPurgeEntityHoldoverWriteOutbox,
  suppressAppHoldoverWriteOutbox,
} from "./holdover-write-deletion";
import { DirectHoldoverWriteCoordinator } from "./holdover-write-outbox";
import {
  deleteEntityOutbox,
  HOLDOVER_WRITE_ENTITY_SUPPRESSED_KEY,
  HOLDOVER_WRITE_JOB_PREFIX,
  HOLDOVER_WRITE_MAX_ATTEMPTS,
  holdoverWriteJobDueAtMs,
  holdoverWriteJobKey,
  holdoverWriteOutboxName,
  holdoverWriteRetryDelayMs,
  purgeEntityOutboxState,
  scopedHoldoverWriteLog,
  suppressEntityOutbox,
} from "./holdover-write-outbox-core";
import { ensureHoldoverWriteJob, runHoldoverWriteAlarm } from "./holdover-write-outbox-ensure";
import { MemoryHoldoverWriteCoordinator } from "./holdover-write-outbox-memory";
import { basePut, FailNTimesPut, MemoryStorage } from "./holdover-write-outbox-test-fixtures";

describe("holdover write outbox core", () => {
  it("names the outbox with the Entity writer slot (no experiment suffix)", () => {
    expect(holdoverWriteOutboxName(basePut)).toBe("app-A:user:v1:hash-abc");
    expect(holdoverWriteOutboxName(basePut)).not.toMatch(/ticket|credential|targetingKey[^H]/i);
    expect(holdoverWriteJobKey(basePut.experimentId)).toBe(
      `${HOLDOVER_WRITE_JOB_PREFIX}${basePut.experimentId}`,
    );
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
      targetingKeyHash: "v1:hash-abc",
      runId: "run-42",
      variant: "treatment",
      attempt: 3,
      status: "pending",
    });
  });

  it("completes on the first successful put without scheduling an alarm or retaining hashes", async () => {
    const put = new FailNTimesPut(0);
    const storage = new MemoryStorage();
    const result = await ensureHoldoverWriteJob(storage, put, basePut, 1_000);
    expect(result).toEqual({ status: "completed" });
    expect(put.calls).toHaveLength(1);
    expect(storage.alarms).toEqual([]);
    expect(storage.job).toBeUndefined();
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
    expect(storage.job).toBeUndefined();
  });

  it("duplicate ensure after completion re-asserts via putIfAbsent without retaining completed rows", async () => {
    const put = new FailNTimesPut(0);
    const storage = new MemoryStorage();
    await ensureHoldoverWriteJob(storage, put, basePut, 1_000);
    const second = await ensureHoldoverWriteJob(storage, put, basePut, 2_000);
    expect(second).toEqual({ status: "completed" });
    expect(put.calls).toHaveLength(2);
    expect(storage.job).toBeUndefined();
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
      const pending = storage.job;
      if (pending === undefined) throw new Error("expected pending holdover write job");
      now = holdoverWriteJobDueAtMs(pending);
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
      targetingKeyHash: "v1:hash-abc",
      runId: "run-42",
      variant: "treatment",
      status: "poisoned",
      attempt: HOLDOVER_WRITE_MAX_ATTEMPTS,
    });
    expect(JSON.stringify(exhaustion?.detail)).not.toMatch(/ticket|pk_|sk_|raw.?targeting/i);
  });
});

describe("holdover write outbox deletion cutoff", () => {
  it("Entity suppress cancels alarms and purge drops pending/poisoned hashes", async () => {
    const put = new FailNTimesPut(5);
    const storage = new MemoryStorage();
    await ensureHoldoverWriteJob(storage, put, basePut, 1_000);
    expect(storage.job?.status).toBe("pending");
    await suppressEntityOutbox(storage, 1_500);
    await runHoldoverWriteAlarm(storage, put, 2_000);
    expect(put.calls).toHaveLength(1);
    await purgeEntityOutboxState(storage, 1_500);
    expect(storage.job).toBeUndefined();
    expect(await storage.get(HOLDOVER_WRITE_ENTITY_SUPPRESSED_KEY)).toEqual({
      deleteBeforeTsMs: 1_500,
    });
  });

  it("Entity cutoff allows post-delete_before_ts ensures while suppressing stale work", async () => {
    const put = new FailNTimesPut(0);
    const storage = new MemoryStorage();
    await ensureHoldoverWriteJob(storage, put, basePut, 1_000, undefined, undefined, {
      sourceCreatedAtMs: 1_000,
    });
    await deleteEntityOutbox(storage, 1_500);
    expect(storage.job).toBeUndefined();
    await expect(
      ensureHoldoverWriteJob(storage, put, basePut, 2_000, undefined, undefined, {
        sourceCreatedAtMs: 1_200,
      }),
    ).resolves.toEqual({ status: "suppressed" });
    await expect(
      ensureHoldoverWriteJob(
        storage,
        put,
        { ...basePut, runId: "run-new" },
        2_000,
        undefined,
        undefined,
        {
          sourceCreatedAtMs: 2_000,
        },
      ),
    ).resolves.toEqual({ status: "completed" });
    expect(put.calls).toHaveLength(2);
  });

  it("App suppress tombstone blocks puts while preserving recoverable jobs", async () => {
    const put = new FailNTimesPut(5);
    const storage = new MemoryStorage();
    await ensureHoldoverWriteJob(storage, put, basePut, 1_000);
    const callsBefore = put.calls.length;
    await ensureHoldoverWriteJob(storage, put, basePut, 2_000, undefined, {
      async isAppSuppressed() {
        return true;
      },
    });
    expect(put.calls).toHaveLength(callsBefore);
    expect(storage.job?.status).toBe("pending");
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
    let nowMs = 1_000;
    const coordinator = new MemoryHoldoverWriteCoordinator(put, undefined, () => nowMs);
    await expect(coordinator.ensure(basePut)).resolves.toEqual({ status: "owned" });
    nowMs += holdoverWriteRetryDelayMs(1);
    await coordinator.alarm(basePut);
    expect(put.calls).toHaveLength(2);
    // Job row deleted on success; a follow-up ensure re-asserts via putIfAbsent.
    await expect(coordinator.ensure(basePut)).resolves.toEqual({ status: "completed" });
    expect(put.calls).toHaveLength(3);
  });
});

describe("holdover write deletion consumer", () => {
  it("suppressAppHoldoverWriteOutbox writes the App suppress tombstone", async () => {
    const kv = new RecordingKv();
    await suppressAppHoldoverWriteOutbox(kv, "app-A");
    expect(kv.raw("holdover-write-suppress:app:app-A")).toBe("1");
  });

  it("suppressAndPurgeEntityHoldoverWriteOutbox posts /delete handshake", async () => {
    const paths: string[] = [];
    const bodies: unknown[] = [];
    const namespace = {
      idFromName(name: string) {
        return name as unknown as DurableObjectId;
      },
      get() {
        return {
          async fetch(input: RequestInfo | URL, init?: RequestInit) {
            paths.push(new URL(String(input)).pathname);
            bodies.push(JSON.parse(String(init?.body)));
            return Response.json({ ok: true });
          },
        };
      },
    };
    await suppressAndPurgeEntityHoldoverWriteOutbox(namespace, {
      ...basePut,
      deleteBeforeTsMs: 1_700,
    });
    expect(paths).toEqual(["/delete"]);
    expect(bodies).toEqual([
      {
        deleteBeforeTsMs: 1_700,
        appId: basePut.appId,
        idType: basePut.idType,
        targetingKeyHash: basePut.targetingKeyHash,
      },
    ]);
  });
});
