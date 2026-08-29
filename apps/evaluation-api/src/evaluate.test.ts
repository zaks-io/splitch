import type { ErrorResponse } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { RecordingAssignmentStore, targetingRule } from "./evaluate/evaluate-path-test-fixtures";
import { type EvaluationCommitEvent, EvaluationCommitSinkError } from "./evaluation-commit-sink";
import {
  API_KEY,
  APP_ID,
  CLIENT_KEY,
  EXPERIMENT_ID,
  LOCKED_CLIENT_KEY,
  makeSdkRouteHarness,
  REVOKED_CLIENT_KEY,
  sdkRouteInit,
} from "./sdk-route-test-fixtures";

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
    expect(res.headers.get("x-run-id")).toBe("run-42");
    // The arm label is public-safe but rides a header, never the body: published
    // SDKs parse this body strictly and an added key makes them serve the
    // caller's default after the Exposure is already committed.
    expect(res.headers.get("x-variant-name")).toBe("treatment");
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
        identityVersion: "v1",
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

  it("reads a schema-v1 credential but fails closed until tenant migration", async () => {
    const { app, exposureSink, evaluationUsageSink } = await makeSdkRouteHarness({
      liveRun: true,
      legacyClientKey: true,
    });

    const res = await app.request(PATH, sdkRouteInit(CLIENT_KEY));

    expect(res.status).toBe(503);
    expect(((await res.json()) as ErrorResponse).code).toBe("SERVICE_UNAVAILABLE");
    expect(exposureSink.writes).toEqual([]);
    expect(evaluationUsageSink.writes).toEqual([]);
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
    expect(res.headers.get("x-variant-name")).toBe("treatment");
    await expect(res.json()).resolves.toEqual({ variant: true });
    expect(exposureSink.writes).toHaveLength(1);
    expect(exposureSink.writes[0]?.appId).toBe(APP_ID);
  });

  it("returns SERVICE_UNAVAILABLE and writes NO holdover when Exposure ingest fails", async () => {
    const { app, assignmentStore } = await makeSdkRouteHarness({
      evaluationCommitSink: new FailingEvaluationCommitSink(),
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

class RejectingAssignmentStore extends RecordingAssignmentStore {
  override put(
    input: Parameters<RecordingAssignmentStore["put"]>[0],
  ): ReturnType<RecordingAssignmentStore["put"]> {
    return super.put(input).then(() => {
      throw new Error("forced stale Assignment generation");
    });
  }
}

describe("POST /api/sdk/evaluate Assignment completion", () => {
  it("does not return success when the required Assignment commit rejects", async () => {
    const assignmentStore = new RejectingAssignmentStore();
    const { app } = await makeSdkRouteHarness({
      assignmentStore,
      liveRun: true,
      runOverrides: { allocation: { control: 0, treatment: 100 }, targetingRules: [] },
    });

    const response = await app.request(PATH, sdkRouteInit(CLIENT_KEY));

    expect(response.status).toBe(503);
    expect(((await response.json()) as ErrorResponse).code).toBe("SERVICE_UNAVAILABLE");
    expect(assignmentStore.putCalls).toHaveLength(1);
  });
});

describe("Evaluation Worker to SDK metadata", () => {
  it("gives the SDK run metadata so a repeat becomes cached telemetry", async () => {
    const { app, evaluationUsageSink } = await makeSdkRouteHarness({
      liveRun: true,
      runOverrides: { allocation: { control: 0, treatment: 100 }, targetingRules: [] },
    });
    const { createSplitchClient } = await import("@splitch/sdk");
    const telemetryRequests: Promise<Response>[] = [];
    const client = createSplitchClient({
      clientKey: CLIENT_KEY,
      endpoint: "https://evaluation.test",
      fetch: ((input: URL | RequestInfo, init?: RequestInit) => {
        const response = Promise.resolve(app.request(String(input), init));
        if (new URL(String(input)).pathname === "/api/sdk/evaluation-telemetry") {
          telemetryRequests.push(response);
        }
        return response;
      }) as typeof fetch,
    });

    await expect(
      client.evaluateDetails("checkout-banner", {
        targetingKey: "user-1",
        idempotencyKey: "sdk-worker-cache-1",
      }),
    ).resolves.toMatchObject({ reason: "SPLIT" });
    await expect(
      client.evaluateDetails("checkout-banner", {
        targetingKey: "user-1",
        idempotencyKey: "sdk-worker-cache-1",
      }),
    ).resolves.toMatchObject({ reason: "CACHED" });
    expect(telemetryRequests).toHaveLength(1);
    await expect(telemetryRequests[0]).resolves.toMatchObject({ status: 200 });

    expect(evaluationUsageSink.writes).toEqual([
      expect.objectContaining({ evaluationCount: 1, isCached: false }),
      expect.objectContaining({
        idempotencyKey: "sdk-worker-cache-1",
        evaluationCount: 0,
        isCached: true,
      }),
    ]);
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
    expect(res.headers.get("x-variant-name")).toBe("control");
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

describe("POST /api/sdk/evaluate: Client Key validation errors", () => {
  it("omits Experiment Entity type from an idType mismatch", async () => {
    const { app } = await makeSdkRouteHarness({
      liveRun: true,
      experimentOverrides: { targetingKeyType: "workspace" },
    });

    const res = await app.request(PATH, sdkRouteInit(CLIENT_KEY));
    const body = (await res.json()) as ErrorResponse;
    const raw = JSON.stringify(body);

    expect(res.status).toBe(400);
    expect(body).toEqual({
      code: "VALIDATION_ERROR",
      message: "idType does not match the Experiment",
      details: { issues: [] },
    });
    expect(raw).not.toContain("workspace");
    expect(raw).not.toContain("targetingKeyType");
  });

  it("omits a configured Targeting Rule regex from an invalid matches Condition", async () => {
    const pattern = "(unclosed";
    const { app } = await makeSdkRouteHarness({
      flagOverrides: {
        experimentId: null,
        targetingRules: [
          targetingRule({
            conditions: [{ attribute: "email", operator: "matches", value: pattern }],
          }),
        ],
      },
    });

    const res = await app.request(PATH, sdkRouteInit(CLIENT_KEY));
    const body = (await res.json()) as ErrorResponse;
    const raw = JSON.stringify(body);

    expect(res.status).toBe(500);
    expect(body).toEqual({
      code: "INTERNAL_SERVER_ERROR",
      message: "evaluation failed",
      details: {},
    });
    expect(raw).not.toContain(pattern);
    expect(raw).not.toContain("Invalid regex");
  });
});

function liveRunHarness() {
  return makeSdkRouteHarness({ liveRun: true });
}

class FailingEvaluationCommitSink {
  async write(_event: EvaluationCommitEvent): Promise<void> {
    throw new EvaluationCommitSinkError("ingest_rejected", "forced failure", { status: 503 });
  }
}
