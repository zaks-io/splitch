import type { ErrorResponse } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { StaticSaltStore } from "./assignment/assignment-store-test-fixtures";
import { baseInput } from "./evaluate/evaluate-path-test-fixtures";
import { EvaluationCommitSinkError, makeHttpEvaluationCommitSink } from "./evaluation-commit-sink";
import {
  APP_ID,
  CLIENT_KEY,
  evaluateAllRouteInit,
  makeSdkRouteHarness,
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
      evaluationCommitSink: new RejectingFetcherEvaluationCommitSink(),
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
        flagKey: "checkout-banner",
        sdkRuntime: "unknown",
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
      expect.objectContaining({
        evaluationCount: 1,
        hasExposure: false,
        isCached: false,
        flagKey: "checkout-banner",
        sdkRuntime: "unknown",
      }),
    ]);
  });

  it("maps Evaluation usage ingest failure before acknowledging a successful Evaluation", async () => {
    const { app } = await makeSdkRouteHarness({
      evaluationCommitSink: new FailingEvaluationCommitSink(),
    });

    const res = await app.request(PATH, sdkRouteInit(CLIENT_KEY));

    expect(res.status).toBe(503);
    expect(((await res.json()) as ErrorResponse).code).toBe("SERVICE_UNAVAILABLE");
  });

  it("logs a dropped Exposure as flat queryable fields naming which stage failed", async () => {
    // The caller gets the same opaque SERVICE_UNAVAILABLE whichever stage broke,
    // so this record is the only place an operator can tell a missing ingest
    // token from ingest rejecting the write.
    const { app, logger } = await makeSdkRouteHarness({
      liveRun: true,
      runOverrides: { allocation: { control: 0, treatment: 100 }, targetingRules: [] },
      evaluationCommitSink: makeHttpEvaluationCommitSink({ token: "", endpoint: "https://x.test" }),
    });

    expect((await app.request(PATH, sdkRouteInit(CLIENT_KEY))).status).toBe(503);

    expect(logger.errors).toEqual([
      {
        message: "evaluation_commit_sink_failed",
        detail: {
          failure: "ingest_token_missing",
          status: null,
          organizationId: "org_verify",
          appId: APP_ID,
          environmentId: "env-1",
          flagKey: "checkout-banner",
          exposureCount: 1,
          causeSummary: "internal ingest token is unavailable",
        },
      },
    ]);
    // The Entity identity never enters a log line.
    expect(JSON.stringify(logger.errors)).not.toContain(baseInput().evaluationContext.targetingKey);
  });

  it("distinguishes an unreachable binding from ingest rejecting the write", async () => {
    const rejecting = await makeSdkRouteHarness({
      evaluationCommitSink: new RejectingFetcherEvaluationCommitSink(),
    });
    expect((await rejecting.app.request(PATH, sdkRouteInit(CLIENT_KEY))).status).toBe(503);

    const refused = await makeSdkRouteHarness({
      evaluationCommitSink: makeHttpEvaluationCommitSink({
        token: "test-token",
        fetcher: { fetch: async () => new Response(null, { status: 500 }) },
      }),
    });
    expect((await refused.app.request(PATH, sdkRouteInit(CLIENT_KEY))).status).toBe(503);

    expect(rejecting.logger.errors[0]?.detail).toMatchObject({
      failure: "ingest_transport_failed",
      status: null,
      causeSummary: "binding unavailable",
    });
    expect(refused.logger.errors[0]?.detail).toMatchObject({
      failure: "ingest_rejected",
      status: 500,
    });
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

describe("POST /api/sdk/evaluation-telemetry: cached Evaluation telemetry", () => {
  it("records cache telemetry as non-billable and does not expose a Targeting Key", async () => {
    const { app, evaluationUsageSink } = await makeSdkRouteHarness();
    const res = await app.request("/api/sdk/evaluation-telemetry", {
      method: "POST",
      headers: {
        authorization: `Bearer ${CLIENT_KEY}`,
        "content-type": "application/json",
        "idempotency-key": "cache-hit-1",
        "x-splitch-sdk-runtime": "javascript",
      },
      body: JSON.stringify({ flagKey: "checkout-banner", idempotencyKey: "cache-hit-1" }),
    });

    expect(res.status).toBe(200);
    expect(evaluationUsageSink.writes).toEqual([
      expect.objectContaining({
        evaluationCount: 0,
        isCached: true,
        hasExposure: false,
        flagKey: "checkout-banner",
        sdkRuntime: "javascript",
      }),
    ]);
    expect(JSON.stringify(evaluationUsageSink.writes)).not.toContain("targetingKey");
  });

  it("rejects cache telemetry when the body identity differs from Idempotency-Key", async () => {
    const { app, evaluationUsageSink } = await makeSdkRouteHarness();
    const res = await app.request("/api/sdk/evaluation-telemetry", {
      method: "POST",
      headers: {
        authorization: `Bearer ${CLIENT_KEY}`,
        "content-type": "application/json",
        "idempotency-key": "cache-hit-header",
      },
      body: JSON.stringify({ flagKey: "checkout-banner", idempotencyKey: "cache-hit-body" }),
    });

    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorResponse).code).toBe("VALIDATION_ERROR");
    expect(evaluationUsageSink.writes).toEqual([]);
  });
});

describe("App identity reset traffic gate", () => {
  it("fails evaluate, evaluate-all, and cached usage before any usage write", async () => {
    const saltStore = new BlockingSaltStore();
    const { app, evaluationUsageSink } = await makeSdkRouteHarness({ saltStore });
    const cached = {
      method: "POST",
      headers: {
        authorization: `Bearer ${CLIENT_KEY}`,
        "content-type": "application/json",
        "idempotency-key": "cache-reset",
      },
      body: JSON.stringify({ flagKey: "checkout-banner", idempotencyKey: "cache-reset" }),
    };

    const responses = await Promise.all([
      app.request(PATH, sdkRouteInit(CLIENT_KEY)),
      app.request("/api/sdk/evaluate-all", evaluateAllRouteInit(CLIENT_KEY)),
      app.request("/api/sdk/evaluation-telemetry", cached),
    ]);

    expect(responses.map((response) => response.status)).toEqual([503, 503, 503]);
    expect(evaluationUsageSink.writes).toEqual([]);
  });
});

class BlockingSaltStore extends StaticSaltStore {
  override async currentKeyVersion(): Promise<string> {
    throw new Error("App identity reset is in progress");
  }
}

class FailingEvaluationCommitSink {
  async write(): Promise<void> {
    throw new EvaluationCommitSinkError("ingest_rejected", "forced failure", { status: 503 });
  }
}

class RejectingFetcherEvaluationCommitSink {
  private readonly sink = makeHttpEvaluationCommitSink({
    token: "test-token",
    fetcher: { fetch: async () => Promise.reject(new Error("binding unavailable")) },
  });

  async write(event: Parameters<typeof this.sink.write>[0]): Promise<void> {
    await this.sink.write(event);
  }
}
