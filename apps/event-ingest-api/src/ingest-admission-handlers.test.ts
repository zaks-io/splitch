import { afterEach, describe, expect, it, vi } from "vitest";
import { EVALUATION_COMMIT_MAX_EXPOSURES } from "./evaluation-commit";
import { ingestAdmissionScopeName } from "./ingest-admission-config";
import { queuePayloadBytes } from "./ingest-admission-gate";
import {
  MemoryEvaluationCommitOutbox,
  MemoryReplayWindow,
} from "./memory-replay-windows.test-fixture";
import {
  type AdmissionCharge,
  appId,
  baseExposure,
  environmentId,
  expectRow,
  makeEnv,
  postEvaluationAt,
  postEvaluationCommit,
  postExposure,
} from "./test-fixtures";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Exposure ingest admission", () => {
  it("charges one raw_events row of queued serialized bytes", async () => {
    const charges: AdmissionCharge[] = [];
    const env = makeEnv(undefined, undefined, { admissionCharges: charges });
    const calls = await postExposure({ env });

    expect(calls.response.status).toBe(202);
    expect(charges).toEqual([
      {
        scope: ingestAdmissionScopeName(appId, environmentId, "raw_events"),
        rowCost: 1,
        byteCost: queuePayloadBytes(expectRow(calls.rows)),
      },
    ]);
  });

  it("rejects an exhausted gate before Tinybird delivery", async () => {
    const charges: AdmissionCharge[] = [];
    const env = makeEnv(undefined, undefined, {
      admission: { allowed: false, retryAfterMs: 2500 },
      admissionCharges: charges,
    });
    const calls = await postExposure({ env });

    expect(calls.response.status).toBe(429);
    await expect(calls.response.json()).resolves.toMatchObject({
      code: "RATE_LIMITED",
      message: "Exposure ingest admission capacity exceeded",
    });
    expect(calls.fetch).not.toHaveBeenCalled();
    expect(charges).toHaveLength(1);
  });

  it.each([false, "throw"] as const)("fails closed when the gate is %s", async (admission) => {
    const calls = await postExposure({
      env: makeEnv(undefined, undefined, { admission }),
    });

    expect(calls.response.status).toBe(429);
    await expect(calls.response.json()).resolves.toMatchObject({
      code: "RATE_LIMITED",
      message: "Ingest Admission Gate is unavailable",
    });
    expect(calls.fetch).not.toHaveBeenCalled();
  });
});

describe("Evaluation usage ingest admission", () => {
  it("charges one raw_evaluations row of queued serialized bytes", async () => {
    const charges: AdmissionCharge[] = [];
    const env = makeEnv(undefined, undefined, { admissionCharges: charges });
    const calls = await postEvaluationAt("2026-07-01T12:34:56.789Z", {}, undefined, env);

    expect(calls.response.status).toBe(202);
    expect(charges).toEqual([
      {
        scope: ingestAdmissionScopeName(appId, environmentId, "raw_evaluations"),
        rowCost: 1,
        byteCost: queuePayloadBytes(expectRow(calls.rows)),
      },
    ]);
  });

  it("rejects an exhausted gate before Tinybird delivery", async () => {
    const env = makeEnv(undefined, undefined, {
      admission: { allowed: false, retryAfterMs: 1800 },
    });
    const calls = await postEvaluationAt("2026-07-01T12:34:56.789Z", {}, undefined, env);

    expect(calls.response.status).toBe(429);
    await expect(calls.response.json()).resolves.toMatchObject({
      code: "RATE_LIMITED",
      message: "Evaluation usage ingest admission capacity exceeded",
    });
    expect(calls.fetch).not.toHaveBeenCalled();
  });

  it.each([false, "throw"] as const)("fails closed when the gate is %s", async (admission) => {
    const calls = await postEvaluationAt(
      "2026-07-01T12:34:56.789Z",
      {},
      undefined,
      makeEnv(undefined, undefined, { admission }),
    );

    expect(calls.response.status).toBe(429);
    await expect(calls.response.json()).resolves.toMatchObject({
      code: "RATE_LIMITED",
      message: "Ingest Admission Gate is unavailable",
    });
    expect(calls.fetch).not.toHaveBeenCalled();
  });
});

describe("Evaluation commit admission", () => {
  it("charges usage and Exposure rows once for a new commit", async () => {
    const charges: AdmissionCharge[] = [];
    const env = makeEnv(undefined, undefined, { admissionCharges: charges });
    const first = await postEvaluationCommit({ env });

    expect(first.response.status).toBe(202);
    expect(first.rows).toHaveLength(2);
    expect(charges).toEqual([
      {
        scope: ingestAdmissionScopeName(appId, environmentId, "raw_evaluations"),
        rowCost: 1,
        byteCost: queuePayloadBytes(expectRow(first.rows)),
      },
      {
        scope: ingestAdmissionScopeName(appId, environmentId, "raw_events"),
        rowCost: 1,
        byteCost: queuePayloadBytes(expectRow(first.rows.slice(1))),
      },
    ]);

    const retry = await postEvaluationCommit({ env });
    expect(retry.response.status).toBe(202);
    expect(retry.rows).toHaveLength(0);
    expect(charges).toHaveLength(2);
  });

  it("does not charge a retry after durable acceptance", async () => {
    const charges: AdmissionCharge[] = [];
    const env = makeEnv(undefined, undefined, { admissionCharges: charges });
    const first = await postEvaluationCommit({ env });
    const retry = await postEvaluationCommit({ env });

    expect(first.response.status).toBe(202);
    expect(retry.response.status).toBe(202);
    expect(charges).toHaveLength(2);
  });

  it("rejects an exhausted gate before sealing or delivering", async () => {
    const outbox = new MemoryEvaluationCommitOutbox();
    const denied = makeEnv(new MemoryReplayWindow(), outbox, {
      admission: { allowed: false, retryAfterMs: 2500 },
    });
    const first = await postEvaluationCommit({ env: denied });

    expect(first.response.status).toBe(429);
    expect(first.fetch).not.toHaveBeenCalled();

    const charges: AdmissionCharge[] = [];
    const allowed = makeEnv(new MemoryReplayWindow(), outbox, { admissionCharges: charges });
    const second = await postEvaluationCommit({ env: allowed });

    expect(second.response.status).toBe(202);
    expect(charges).toHaveLength(2);
  });

  it.each([false, "throw"] as const)("fails closed when the gate is %s", async (admission) => {
    const calls = await postEvaluationCommit({
      env: makeEnv(undefined, undefined, { admission }),
    });

    expect(calls.response.status).toBe(429);
    await expect(calls.response.json()).resolves.toMatchObject({
      code: "RATE_LIMITED",
      message: "Ingest Admission Gate is unavailable",
    });
    expect(calls.fetch).not.toHaveBeenCalled();
  });

  it("rejects an oversized Exposure batch before Run-scope lookups or Tinybird delivery", async () => {
    const env = makeEnv();
    const store = env.CONFIG_STORE as unknown as {
      get: (key: string) => Promise<string | null>;
    };
    const get = vi.spyOn(store, "get");

    const calls = await postEvaluationCommit({
      env,
      exposures: Array.from({ length: EVALUATION_COMMIT_MAX_EXPOSURES + 1 }, () => baseExposure()),
    });

    expect(calls.response.status).toBe(400);
    await expect(calls.response.json()).resolves.toMatchObject({
      code: "VALIDATION_ERROR",
      message: `Evaluation commit exposures exceed ${EVALUATION_COMMIT_MAX_EXPOSURES}`,
    });
    expect(get).not.toHaveBeenCalled();
    expect(calls.fetch).not.toHaveBeenCalled();
  });
});
