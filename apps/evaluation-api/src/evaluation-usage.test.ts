import type { ErrorResponse } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { EvaluationUsageSinkError } from "./evaluation-usage-sink";
import { makeHttpEvaluationUsageSink } from "./evaluation-usage-sink";
import {
  APP_ID,
  CLIENT_KEY,
  makeSdkRouteHarness,
  RecordingEvaluationUsageSink,
  sdkRouteInit,
} from "./sdk-route-test-fixtures";

const PATH = "/api/sdk/evaluate";

describe("POST /api/sdk/evaluate: logical Evaluation identity", () => {
  it("rejects an Evaluation without a caller-owned logical identity", async () => {
    const { app, exposureSink, evaluationUsageSink } = await makeSdkRouteHarness({ liveRun: true });
    const init = sdkRouteInit(CLIENT_KEY);
    const headers = new Headers(init.headers);
    headers.delete("idempotency-key");

    const res = await app.request(PATH, { ...init, headers });

    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorResponse).code).toBe("VALIDATION_ERROR");
    expect(exposureSink.writes).toEqual([]);
    expect(evaluationUsageSink.writes).toEqual([]);
  });
});

describe("POST /api/sdk/evaluate: Evaluation usage telemetry", () => {
  it("maps a rejected usage service binding fetch to a retryable failure", async () => {
    const { app } = await makeSdkRouteHarness({
      evaluationUsageSink: new RejectingFetcherEvaluationUsageSink(),
    });

    const res = await app.request(PATH, sdkRouteInit(CLIENT_KEY));

    expect(res.status).toBe(503);
    expect(((await res.json()) as ErrorResponse).code).toBe("SERVICE_UNAVAILABLE");
  });

  it("records one remote Evaluation with its exposure dimension before returning success", async () => {
    const { app, evaluationUsageSink } = await makeSdkRouteHarness({
      liveRun: true,
      runOverrides: { allocation: { control: 0, treatment: 100 }, targetingRules: [] },
    });

    const res = await app.request(PATH, sdkRouteInit(CLIENT_KEY));

    expect(res.status).toBe(200);
    expect(evaluationUsageSink.writes).toEqual([
      {
        idempotencyKey: expect.any(String),
        organizationId: "org_verify",
        appId: APP_ID,
        environmentId: "env-1",
        evaluationCount: 1,
        isBatch: false,
        isCached: false,
        hasExposure: true,
      },
    ]);
  });

  it("records a non-Exposure Evaluation without changing Exposure behavior", async () => {
    const { app, evaluationUsageSink, exposureSink } = await makeSdkRouteHarness({
      flagOverrides: { enabled: false },
    });

    const res = await app.request(PATH, sdkRouteInit(CLIENT_KEY));

    expect(res.status).toBe(200);
    expect(exposureSink.writes).toEqual([]);
    expect(evaluationUsageSink.writes).toEqual([
      expect.objectContaining({ evaluationCount: 1, hasExposure: false, isCached: false }),
    ]);
  });

  it("maps Evaluation usage ingest failure before acknowledging a successful Evaluation", async () => {
    const { app } = await makeSdkRouteHarness({
      evaluationUsageSink: new FailingEvaluationUsageSink(),
    });

    const res = await app.request(PATH, sdkRouteInit(CLIENT_KEY));

    expect(res.status).toBe(503);
    expect(((await res.json()) as ErrorResponse).code).toBe("SERVICE_UNAVAILABLE");
  });

  it("reuses the Idempotency-Key for a client retry", async () => {
    const { app, evaluationUsageSink } = await makeSdkRouteHarness({
      liveRun: true,
      runOverrides: { allocation: { control: 0, treatment: 100 }, targetingRules: [] },
    });

    const init = sdkRouteInit(CLIENT_KEY, { "idempotency-key": "eval-retry-1" });
    expect((await app.request(PATH, init)).status).toBe(200);
    expect((await app.request(PATH, init)).status).toBe(200);

    expect(evaluationUsageSink.writes.map((event) => event.idempotencyKey)).toEqual([
      "eval-retry-1",
      "eval-retry-1",
    ]);
  });
});

class FailingEvaluationUsageSink extends RecordingEvaluationUsageSink {
  override async write(): Promise<void> {
    throw new EvaluationUsageSinkError("forced failure");
  }
}

class RejectingFetcherEvaluationUsageSink extends RecordingEvaluationUsageSink {
  private readonly sink = makeHttpEvaluationUsageSink({
    token: "test-token",
    fetcher: { fetch: async () => Promise.reject(new Error("binding unavailable")) },
  });

  override async write(event: Parameters<RecordingEvaluationUsageSink["write"]>[0]): Promise<void> {
    await this.sink.write(event);
  }
}
