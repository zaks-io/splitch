import type { ErrorResponse } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import {
  API_KEY,
  APP_ID,
  CLIENT_KEY,
  EXPERIMENT_ID,
  LOCKED_CLIENT_KEY,
  RecordingExposureSink,
  RecordingEvaluationUsageSink,
  REVOKED_CLIENT_KEY,
  makeSdkRouteHarness,
  sdkRouteInit,
} from "./sdk-route-test-fixtures";
import { ExposureSinkError } from "./exposure-sink";
import { EvaluationUsageSinkError } from "./evaluation-usage-sink";

const PATH = "/api/sdk/evaluate";

describe("POST /api/sdk/evaluate", () => {
  it("returns only { variant } and writes exactly one Exposure on a fresh live Run", async () => {
    const { app, assignmentStore, exposureSink } = await makeSdkRouteHarness({
      liveRun: true,
      runOverrides: { allocation: { control: 0, treatment: 100 }, targetingRules: [] },
    });

    const res = await app.request(PATH, sdkRouteInit(CLIENT_KEY));
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body).toEqual({ variant: true });
    expect(Object.keys(body)).toEqual(["variant"]);
    expect(JSON.stringify(body)).not.toContain("reason");
    expect(JSON.stringify(body)).not.toContain("rule");
    expect(JSON.stringify(body)).not.toContain("salt");
    expect(exposureSink.writes).toHaveLength(1);
    expect(exposureSink.writes[0]).toMatchObject({
      appId: APP_ID,
      experimentId: EXPERIMENT_ID,
      runId: "run-42",
      variantName: "treatment",
      type: "exposure",
      isHoldover: false,
    });
    // The first Exposure records the sticky first-touch winner in the
    // Assignment Store (holdover-write-contract.md).
    expect(assignmentStore.putCalls).toEqual([
      {
        appId: APP_ID,
        idType: "user",
        targetingKey: "user-1",
        experimentId: EXPERIMENT_ID,
        runId: "run-42",
        variant: "treatment",
      },
    ]);
  });

  it("rejects missing, invalid, and revoked Client Keys before evaluation", async () => {
    const { app, assignmentStore, exposureSink } = await makeSdkRouteHarness({ liveRun: true });

    const missing = await app.request(PATH, sdkRouteInit());
    const invalid = await app.request(PATH, sdkRouteInit("pk_not_known"));
    const revoked = await app.request(PATH, sdkRouteInit(REVOKED_CLIENT_KEY));

    expect(missing.status).toBe(401);
    expect(((await missing.json()) as ErrorResponse).code).toBe("UNAUTHORIZED");
    expect(invalid.status).toBe(401);
    expect(((await invalid.json()) as ErrorResponse).code).toBe("UNAUTHORIZED");
    expect(revoked.status).toBe(403);
    expect(((await revoked.json()) as ErrorResponse).code).toBe("CREDENTIAL_REVOKED");
    expect(assignmentStore.getAllCalls).toEqual([]);
    expect(exposureSink.writes).toEqual([]);
  });

  it("rejects API Keys before evaluation", async () => {
    const { app, assignmentStore, configKv, exposureSink } = await liveRunHarness();

    const res = await app.request(PATH, sdkRouteInit(API_KEY));
    const body = (await res.json()) as ErrorResponse;

    expect(res.status).toBe(401);
    expect(body.code).toBe("UNAUTHORIZED");
    expect(configKv.getCalls).toEqual([]);
    expect(assignmentStore.getAllCalls).toEqual([]);
    expect(exposureSink.writes).toEqual([]);
  });

  it("enforces a Client Key origin allow-list before evaluation", async () => {
    const { app, assignmentStore, configKv, exposureSink } = await liveRunHarness();

    const res = await app.request(
      PATH,
      sdkRouteInit(LOCKED_CLIENT_KEY, { origin: "https://evil.example.test" }),
    );
    const body = (await res.json()) as ErrorResponse;

    expect(res.status).toBe(403);
    expect(body.code).toBe("ORIGIN_NOT_ALLOWED");
    expect(configKv.getCalls).toEqual([]);
    expect(assignmentStore.getAllCalls).toEqual([]);
    expect(exposureSink.writes).toEqual([]);
  });

  it("treats body appId as an assertion and rejects mismatches without data access", async () => {
    const { app, assignmentStore, configKv, exposureSink } = await makeSdkRouteHarness({
      liveRun: true,
    });

    const res = await app.request(PATH, sdkRouteInit(CLIENT_KEY, {}, { appId: "app-other" }));
    const body = (await res.json()) as ErrorResponse;

    expect(res.status).toBe(403);
    expect(body.code).toBe("APP_MISMATCH");
    expect(body).not.toHaveProperty("variant");
    expect(configKv.getCalls).toEqual([]);
    expect(assignmentStore.getAllCalls).toEqual([]);
    expect(exposureSink.writes).toEqual([]);
  });

  it.each([
    ["empty appId", { appId: "" }, "appId"],
    ["empty flagKey", { flagKey: "" }, "flagKey"],
  ] as const)("returns VALIDATION_ERROR for %s before handler data access", async (_case, body, field) => {
    const { app, assignmentStore, configKv, credentialKv, exposureSink } = await liveRunHarness();

    const res = await app.request(PATH, sdkRouteInit(CLIENT_KEY, {}, body));
    const response = (await res.json()) as ErrorResponse;

    expect(res.status).toBe(400);
    expect(response.code).toBe("VALIDATION_ERROR");
    expect(JSON.stringify(response.details)).toContain(field);
    expect(credentialKv.getCalls).toEqual([]);
    expect(configKv.getCalls).toEqual([]);
    expect(assignmentStore.getAllCalls).toEqual([]);
    expect(exposureSink.writes).toEqual([]);
  });

  it("accepts a matching body appId without letting it choose scope", async () => {
    const { app, exposureSink } = await makeSdkRouteHarness({
      liveRun: true,
      runOverrides: { allocation: { control: 0, treatment: 100 }, targetingRules: [] },
    });

    const res = await app.request(PATH, sdkRouteInit(CLIENT_KEY, {}, { appId: APP_ID }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ variant: true });
    expect(exposureSink.writes).toHaveLength(1);
    expect(exposureSink.writes[0]?.appId).toBe(APP_ID);
  });

  it("returns SERVICE_UNAVAILABLE and writes NO holdover when Exposure ingest fails", async () => {
    const { app, assignmentStore } = await makeSdkRouteHarness({
      exposureSink: new FailingExposureSink(),
      liveRun: true,
      runOverrides: { allocation: { control: 0, treatment: 100 }, targetingRules: [] },
    });

    const res = await app.request(PATH, sdkRouteInit(CLIENT_KEY));
    const body = (await res.json()) as ErrorResponse;

    expect(res.status).toBe(503);
    expect(body.code).toBe("SERVICE_UNAVAILABLE");
    // The holdover must NOT be recorded when the Exposure was not persisted:
    // otherwise the SDK re-fire would hit the holdover-replay path (no Exposure)
    // and the entity's Exposure would be lost for this Run. The re-fire instead
    // re-assigns deterministically and re-attempts the Exposure.
    expect(assignmentStore.putCalls).toEqual([]);
  });
});

describe("POST /api/sdk/evaluate: Evaluation usage telemetry", () => {
  it("records one remote Evaluation with its exposure dimension before returning success", async () => {
    const { app, evaluationUsageSink } = await makeSdkRouteHarness({
      liveRun: true,
      runOverrides: { allocation: { control: 0, treatment: 100 }, targetingRules: [] },
    });

    const res = await app.request(PATH, sdkRouteInit(CLIENT_KEY));

    expect(res.status).toBe(200);
    expect(evaluationUsageSink.writes).toEqual([
      {
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
});

describe("POST /api/sdk/evaluate: non-exposing outcomes", () => {
  it("returns a holdover Variant without firing another Exposure", async () => {
    const { app, assignmentStore, exposureSink } = await makeSdkRouteHarness({
      liveRun: true,
      holdovers: new Map([[EXPERIMENT_ID, { runId: "run-prior", variant: "control" }]]),
      runOverrides: { allocation: { control: 0, treatment: 100 }, targetingRules: [] },
    });

    const res = await app.request(PATH, sdkRouteInit(CLIENT_KEY));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ variant: false });
    expect(exposureSink.writes).toEqual([]);
    // A replayed holdover never re-writes the Assignment Store.
    expect(assignmentStore.putCalls).toEqual([]);
  });

  it.each([
    ["disabled Flag", { flagOverrides: { enabled: false } }],
    ["no controlling Experiment", { flagOverrides: { experimentId: null } }],
  ] as const)("returns a Variant for %s without firing Exposure", async (_caseName, options) => {
    const { app, exposureSink } = await makeSdkRouteHarness(options);

    const res = await app.request(PATH, sdkRouteInit(CLIENT_KEY));
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(Object.keys(body)).toEqual(["variant"]);
    expect(exposureSink.writes).toEqual([]);
  });
});

function liveRunHarness() {
  return makeSdkRouteHarness({ liveRun: true });
}

class FailingExposureSink extends RecordingExposureSink {
  override async write(): Promise<void> {
    throw new ExposureSinkError("forced failure");
  }
}

class FailingEvaluationUsageSink extends RecordingEvaluationUsageSink {
  override async write(): Promise<void> {
    throw new EvaluationUsageSinkError("forced failure");
  }
}
