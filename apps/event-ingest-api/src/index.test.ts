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
  it("appends a validated raw_events row through waitUntil", async () => {
    const calls = await postExposure();
    const row = expectRow(calls.rows);

    expect(calls.response.status).toBe(202);
    expect(calls.fetch).toHaveBeenCalledTimes(1);
    expect(calls.fetch.mock.calls[0]?.[0]).toBe("https://tinybird.test/v0/events?name=raw_events");
    expect(row).toMatchObject({
      app_id: appId,
      environment_id: environmentId,
      experiment_id: experimentId,
      run_id: liveRunId,
      id_type: "user",
      event_id: "evt_retry_1",
      server_received_at: fixedNow,
      ingest_ts: fixedNow,
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
    expect(calls.fetch.mock.calls[0]?.[0]).toBe(
      "https://tinybird.test/v0/events?name=raw_evaluations",
    );
    expect(calls.fetch.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: "Bearer tb_raw_evaluations_ingest_secret",
    });
    expect(row).toMatchObject({
      organization_id: organizationId,
      app_id: appId,
      environment_id: environmentId,
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

  it("keeps the logical Evaluation id stable across retries", async () => {
    const first = await postEvaluation();
    const second = await postEvaluation();

    expect(expectRow(first.rows).dedup_key).toBe("eval-request-1");
    expect(expectRow(second.rows).dedup_key).toBe("eval-request-1");
  });
});

describe("Exposure ingest", () => {
  it("returns 503 (no ACK) and logs when the Tinybird append fails", async () => {
    // The ACK is the at-least-once delivery receipt for the Evaluation Worker;
    // a failed append must surface as SERVICE_UNAVAILABLE so the evaluate call
    // fails loud and the SDK re-fires, never as a silent 202 drop.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const calls = await postExposure({ tinybirdStatus: 500 });

    expect(calls.response.status).toBe(503);
    await expect(calls.response.json()).resolves.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(error).toHaveBeenCalledWith(
      "event-ingest-api Tinybird append failed",
      expect.objectContaining({
        appId,
        eventId: "evt_retry_1",
        errorMessage: "Tinybird append failed with HTTP 500",
      }),
    );
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

  it("rejects unauthenticated requests before parsing the body", async () => {
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

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: "UNAUTHORIZED" });
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
