import type { ErrorResponse } from "@splitch/contracts";
import type { SaltStore } from "@splitch/privacy";
import { describe, expect, it } from "vitest";
import {
  AppIdentityAdmissionError,
  admitAppIdentity,
  admittedAssignmentStore,
} from "./app-identity-traffic";
import { StaticSaltStore } from "./assignment/assignment-store-test-fixtures";
import {
  API_KEY,
  APP_ID,
  CLIENT_KEY,
  evaluateAllRouteInit,
  makeSdkRouteHarness,
  sdkRouteInit,
} from "./sdk-route-test-fixtures";

describe("Evaluation request identity admission", () => {
  it.each([
    ["evaluate", "/api/sdk/evaluate", () => sdkRouteInit(CLIENT_KEY), 3],
    ["evaluate-all", "/api/sdk/evaluate-all", () => evaluateAllRouteInit(CLIENT_KEY), 3],
    ["Peek", "/api/sdk/peek", () => sdkRouteInit(API_KEY), 3],
    ["Verify", "/api/sdk/verify", () => sdkRouteInit(CLIENT_KEY), 3],
    ["cached telemetry", "/api/sdk/evaluation-telemetry", cachedTelemetryInit, 2],
  ])("rejects paused %s work resumed under a replacement generation", async (_, path, init, pauseOn) => {
    const saltStore = new PausingSaltStore(pauseOn);
    const harness = await makeSdkRouteHarness({ saltStore });

    const response = harness.app.request(path, init());
    await saltStore.paused;
    saltStore.replaceIdentity();

    const completed = await response;
    expect(completed.status).toBe(503);
    expect(((await completed.json()) as ErrorResponse).code).toBe("SERVICE_UNAVAILABLE");
    expect(harness.exposureSink.writes).toEqual([]);
    expect(harness.evaluationUsageSink.writes).toEqual([]);
    expect(harness.assignmentStore.putCalls).toEqual([]);
  });

  it("pins a paused Assignment write to admission and rejects it before the store", async () => {
    const saltStore = new PausingSaltStore(2);
    const admission = await admitAppIdentity(saltStore, APP_ID);
    const calls: unknown[] = [];
    const store = admittedAssignmentStore(
      {
        async getAll() {
          return new Map();
        },
        async put(input) {
          calls.push(input);
          return { status: "stored" as const, assignment: { runId: "run-1", variant: "control" } };
        },
        async putHashed() {
          throw new Error("not used");
        },
      },
      admission,
    );

    const write = store.put({
      appId: APP_ID,
      experimentId: "exp-1",
      idType: "user",
      targetingKey: "entity-1",
      runId: "run-1",
      variant: "control",
    });
    await saltStore.paused;
    saltStore.replaceIdentity();

    await expect(write).rejects.toBeInstanceOf(AppIdentityAdmissionError);
    expect(calls).toEqual([]);
  });
});

class PausingSaltStore extends StaticSaltStore implements SaltStore {
  private calls = 0;
  private version = "app-v1";
  private resume!: () => void;
  private readonly gate = new Promise<void>((resolve) => {
    this.resume = resolve;
  });
  private entered!: () => void;
  readonly paused = new Promise<void>((resolve) => {
    this.entered = resolve;
  });

  constructor(private readonly pauseOn: number) {
    super();
  }

  override async currentKeyVersion(): Promise<string> {
    this.calls += 1;
    if (this.calls === this.pauseOn) {
      this.entered();
      await this.gate;
    }
    return this.version;
  }

  replaceIdentity(): void {
    this.version = "app-v2";
    this.resume();
  }
}

function cachedTelemetryInit(): RequestInit {
  return {
    method: "POST",
    headers: {
      authorization: `Bearer ${CLIENT_KEY}`,
      "content-type": "application/json",
      "idempotency-key": "cached-reset-race",
    },
    body: JSON.stringify({
      flagKey: "checkout-banner",
      idempotencyKey: "cached-reset-race",
    }),
  };
}
