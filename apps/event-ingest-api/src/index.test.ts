import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "./index";
import {
  appId,
  clientAppId,
  environmentId,
  expectRow,
  experimentId,
  fixedNow,
  liveRunId,
  makeEnv,
  mockTinybirdFetch,
  organizationId,
  postEvaluation,
  postEvaluationAt,
  postExposure,
  priorRunId,
  TestExecutionContext,
  workerRequest,
} from "./test-fixtures";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("Event Ingest Worker", () => {
  it("hands a validated raw_events row to its durable queue", async () => {
    const calls = await postExposure();
    const row = expectRow(calls.rows);

    expect(calls.response.status).toBe(202);
    expect(calls.fetch).not.toHaveBeenCalled();
    expect(row).toMatchObject({
      app_id: appId,
      environment_id: environmentId,
      experiment_id: experimentId,
      run_id: liveRunId,
      id_type: "user",
      event_id: "evt_retry_1",
      exposure_at: fixedNow,
      server_received_at: fixedNow,
      client_timestamp: "2026-07-01T12:00:00.000Z",
      variant: "treatment",
      is_holdover: 0,
      counterfactual: 0,
      sdk_version: "sdk-test",
    });
    expect(String(row.dedup_key)).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});

describe("Evaluation usage ingest", () => {
  it("appends a non-Exposure Evaluation to its separate raw datasource", async () => {
    const calls = await postEvaluation();
    const row = expectRow(calls.rows);

    expect(calls.response.status).toBe(202);
    expect(calls.fetch).not.toHaveBeenCalled();
    expect(row).toMatchObject({
      organization_id: organizationId,
      app_id: appId,
      environment_id: environmentId,
      flag_key: "checkout",
      sdk_runtime: "javascript",
      evaluation_count: 1,
      is_batch: 0,
      is_cached: 0,
      has_exposure: 0,
      server_received_at: fixedNow,
    });
    expect(row).not.toHaveProperty("targeting_key_hash");
  });

  it("rejects cached rows that claim consumed Evaluations", async () => {
    const calls = await postEvaluation({ evaluationCount: 1, isCached: true });

    expect(calls.response.status).toBe(400);
    await expect(calls.response.json()).resolves.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(calls.fetch).not.toHaveBeenCalled();
  });

  it("preserves a batch's consumed Evaluation count", async () => {
    const calls = await postEvaluation({ evaluationCount: 10, isBatch: true });

    expect(calls.response.status).toBe(202);
    expect(expectRow(calls.rows)).toMatchObject({ evaluation_count: 10, is_batch: 1 });
  });

  it("deduplicates retries without storing the caller's raw Evaluation id", async () => {
    const env = makeEnv();
    const first = await postEvaluationAt(fixedNow, {}, undefined, env);
    const second = await postEvaluationAt(fixedNow, {}, undefined, env);

    expect(expectRow(first.rows).dedup_key).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(expectRow(second.rows).dedup_key).toBe(expectRow(first.rows).dedup_key);
    expect(expectRow(first.rows).dedup_key).not.toContain("eval-request-1");
  });

  it("does not let a shared caller idempotency key deduplicate another App or Organization", async () => {
    const first = await postEvaluation();
    const other = await postEvaluationAt(
      fixedNow,
      {},
      {
        appId: "app_other",
        environmentId: "env_other",
        organizationId: "org_other",
      },
    );

    expect(expectRow(other.rows).dedup_key).not.toBe(expectRow(first.rows).dedup_key);
  });

  it("keeps cached telemetry from preclaiming the replay identity of a remote Evaluation", async () => {
    const env = makeEnv();
    const cached = await postEvaluationAt(
      fixedNow,
      { evaluationCount: 0, isCached: true },
      undefined,
      env,
    );
    const remote = await postEvaluationAt(fixedNow, {}, undefined, env);

    expect(expectRow(cached.rows).dedup_key).not.toBe(expectRow(remote.rows).dedup_key);
    expect(expectRow(remote.rows)).toMatchObject({ evaluation_count: 1, is_cached: 0 });
  });

  it("expires an Evaluation idempotency key after its 24-hour replay window", async () => {
    const env = makeEnv();
    const first = await postEvaluationAt(fixedNow, {}, undefined, env);
    const second = await postEvaluationAt("2026-07-02T12:34:56.789Z", {}, undefined, env);

    expect(expectRow(second.rows).dedup_key).not.toBe(expectRow(first.rows).dedup_key);
  });

  it("keeps a retry across midnight inside the first receipt's 24-hour replay window", async () => {
    const env = makeEnv();
    const first = await postEvaluationAt("2026-07-01T23:59:59.999Z", {}, undefined, env);
    const retry = await postEvaluationAt("2026-07-02T00:00:00.001Z", {}, undefined, env);

    expect(expectRow(retry.rows).dedup_key).toBe(expectRow(first.rows).dedup_key);
  });
});

describe("Exposure ingest", () => {
  it("does not make client success depend on a failing Tinybird sink", async () => {
    const calls = await postExposure({ tinybirdStatus: 500 });

    expect(calls.response.status).toBe(202);
    expect(calls.rows).toHaveLength(1);
    expect(calls.fetch).not.toHaveBeenCalled();
  });

  it("fails loud when the durable queue handoff itself fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const env = makeEnv();
    vi.mocked(env.RAW_EVENTS_QUEUE.send).mockRejectedValueOnce(new Error("queue unavailable"));

    const calls = await postExposure({ env });

    expect(calls.response.status).toBe(503);
    await expect(calls.response.json()).resolves.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message: "raw event queue handoff failed",
    });
    expect(calls.fetch).not.toHaveBeenCalled();
  });

  it("stamps the payload's fire-time runId even when a newer Run is live", async () => {
    // Run-boundary skew: the exposure fired under the prior Run; relabeling it
    // with the ingest-time live Run would corrupt the new Run's first-touch.
    const calls = await postExposure({ payload: { runId: priorRunId } });
    const row = expectRow(calls.rows);

    expect(calls.response.status).toBe(202);
    expect(row.run_id).toBe(priorRunId);
  });

  it("rejects a runId that names no Run config", async () => {
    const calls = await postExposure({ payload: { runId: "run_never_existed" } });

    expect(calls.response.status).toBe(404);
    await expect(calls.response.json()).resolves.toMatchObject({ code: "RUN_NOT_FOUND" });
    expect(calls.fetch).not.toHaveBeenCalled();
  });

  it("rejects an idType mismatch before Tinybird append", async () => {
    const calls = await postExposure({ payload: { idType: "workspace" } });

    expect(calls.response.status).toBe(400);
    await expect(calls.response.json()).resolves.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(calls.fetch).not.toHaveBeenCalled();
    expect(calls.ctx.waits).toHaveLength(0);
  });

  it("does not mount internal ingest on the public Worker", async () => {
    const fetch = mockTinybirdFetch();
    const ctx = new TestExecutionContext();

    const response = await worker.fetch(
      workerRequest("https://event-ingest.test/api/internal/exposures", {
        method: "POST",
        headers: {
          authorization: "Bearer wrong",
          "content-type": "application/json",
          "x-splitch-app-id": appId,
          "x-splitch-environment-id": environmentId,
        },
        body: "{",
      }),
      makeEnv(),
      ctx,
    );

    expect(response.status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
    expect(ctx.waits).toHaveLength(0);
  });

  it("ignores client-supplied appId and environmentId", async () => {
    const calls = await postExposure({
      payload: { appId: clientAppId, environmentId: "env_from_client" },
    });
    const row = expectRow(calls.rows);

    expect(row.app_id).toBe(appId);
    expect(row.environment_id).toBe(environmentId);
  });

  it("uses the server receipt clock for Exposure and Activation encounter time", async () => {
    const exposure = await postExposure({ payload: { exposureAt: "2000-01-01T00:00:00.000Z" } });
    const activation = await postExposure({
      payload: {
        type: "activation",
        exposureAt: "2000-01-01T00:00:00.000Z",
      },
    });

    expect(expectRow(exposure.rows)).toMatchObject({
      type: "exposure",
      exposure_at: fixedNow,
      server_received_at: fixedNow,
    });
    expect(expectRow(exposure.rows)).not.toHaveProperty("ingest_ts");
    expect(expectRow(activation.rows)).toMatchObject({
      type: "activation",
      exposure_at: fixedNow,
      server_received_at: fixedNow,
      activation_ts: fixedNow,
    });
    expect(expectRow(activation.rows)).not.toHaveProperty("ingest_ts");
  });

  it("stores a missing diagnostic client timestamp as null", async () => {
    const calls = await postExposure({ payload: { clientTimestamp: undefined } });
    expect(expectRow(calls.rows)).toHaveProperty("client_timestamp", null);
  });

  it("keeps event_id and dedup_key stable across retries", async () => {
    const first = await postExposure();
    const second = await postExposure();
    const firstRow = expectRow(first.rows);
    const secondRow = expectRow(second.rows);

    expect(firstRow.event_id).toBe("evt_retry_1");
    expect(secondRow.event_id).toBe("evt_retry_1");
    expect(firstRow.dedup_key).toBe(secondRow.dedup_key);
  });

  it("does not append from peek or test-eval paths", async () => {
    const fetch = mockTinybirdFetch();
    const env = makeEnv();
    const ctx = new TestExecutionContext();

    const peek = await worker.fetch(
      workerRequest("https://event-ingest.test/api/sdk/peek", { method: "POST" }),
      env,
      ctx,
    );
    const testEval = await worker.fetch(
      workerRequest("https://event-ingest.test/apps/app/envs/env/flags/flag/test-eval", {
        method: "POST",
      }),
      env,
      ctx,
    );

    expect(peek.status).toBe(404);
    expect(testEval.status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
    expect(ctx.waits).toHaveLength(0);
  });
});
