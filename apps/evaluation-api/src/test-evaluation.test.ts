import { type ErrorResponse, experimentConfigKey, flagConfigKey } from "@splitch/contracts";
import type { AuthResolver, Principal, RateLimiter } from "@splitch/worker-runtime";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";
import { StaticSaltStore } from "./assignment/assignment-store-test-fixtures";
import {
  baseInput,
  EXPERIMENT_ID,
  RecordingAssignmentStore,
  targetingRule,
} from "./evaluate/evaluate-path-test-fixtures";
import { RecordingExposureIngestSink } from "./exposure-redemption";
import { MemoryExposureRedemptionClaimStore } from "./exposure-redemption-claim";
import { FakeKv } from "./provider/fake-kv";
import { experimentConfigKV, flagConfigKV } from "./provider/fixtures";
import { KvProvider } from "./provider/kv-provider";
import {
  RecordingEvaluationCommitSink,
  RecordingEvaluationUsageSink,
  RecordingExposureSink,
} from "./sdk-route-test-fixtures";

const APP_ID = "app-A";
const ENVIRONMENT_ID = "env-1";
const FLAG_KEY = "checkout-banner";
const PATH = `/apps/${APP_ID}/envs/${ENVIRONMENT_ID}/flags/${FLAG_KEY}/test-eval`;

const allowLimiter: RateLimiter = () => ({ limited: false });

function principal(appId: string): Principal {
  return {
    kind: "control-plane-token",
    id: "actor-1",
    scopes: [`app:${appId}:admin`],
    orgId: null,
    appId,
    environmentId: null,
    authDoor: "id_jag",
  };
}

const authResolver: AuthResolver = (request) => {
  const authorization = request.headers.get("authorization");
  if (authorization === "Bearer cp-app-A") {
    return { ok: true, principal: principal(APP_ID) };
  }
  if (authorization === "Bearer cp-other-app") {
    return { ok: true, principal: principal("app-other") };
  }
  return { ok: false, reason: "UNAUTHORIZED" };
};

const dataPlaneAuthResolver: AuthResolver = () => ({ ok: false, reason: "UNAUTHORIZED" });

function seededKv(): FakeKv {
  return new FakeKv()
    .put(
      flagConfigKey(APP_ID, ENVIRONMENT_ID, FLAG_KEY),
      flagConfigKV({
        experimentId: EXPERIMENT_ID,
        targetingRules: [targetingRule({ id: "rule-enterprise" })],
      }),
    )
    .put(
      experimentConfigKey(APP_ID, ENVIRONMENT_ID, EXPERIMENT_ID),
      experimentConfigKV({ liveRunId: null, status: "draft" }),
    );
}

function makeHarness(saltStore = new StaticSaltStore(), sourceId: () => string = () => "pop-test") {
  const configKv = seededKv();
  const assignmentStore = new RecordingAssignmentStore();
  const app = createApp({
    // Addressed at the Control Plane, executed here over the binding (ADR-0046).
    door: "binding",
    authResolver,
    dataPlaneAuthResolver,
    rateLimiter: allowLimiter,
    provider: new KvProvider(configKv),
    assignmentStore,
    exposureAssembly: {
      saltStore,
      sourceId,
    },
    exposureTicket: {
      saltStore,
      ticketKey: "splitch-test-exposure-ticket-key-32chars",
    },
    exposureIngestSink: new RecordingExposureIngestSink(),
    exposureRedemptionClaims: new MemoryExposureRedemptionClaimStore(),
    evaluationCommitSink: new RecordingEvaluationCommitSink(
      new RecordingExposureSink(),
      new RecordingEvaluationUsageSink(),
    ),
    evaluationUsageSink: new RecordingEvaluationUsageSink(),
  });
  return { app, assignmentStore, configKv };
}

function testEvalInit(token?: string): RequestInit {
  return {
    method: "POST",
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      evaluationContext: baseInput().evaluationContext,
    }),
  };
}

describe("POST /apps/:appId/envs/:environmentId/flags/:flagKey/test-eval", () => {
  it("rejects a dry-run paused across an App identity replacement", async () => {
    const saltStore = new TestEvalPausingSaltStore();
    const { app, assignmentStore } = makeHarness(saltStore);

    const response = app.request(PATH, testEvalInit("cp-app-A"));
    await saltStore.paused;
    saltStore.replaceIdentity();

    expect((await response).status).toBe(503);
    expect(assignmentStore.putCalls).toEqual([]);
  });

  it("returns the full rule_matched reason without resolving an Exposure source", async () => {
    const { app, assignmentStore, configKv } = makeHarness(new StaticSaltStore(), () => {
      throw new Error("Cloudflare colo is unavailable for Exposure source identity");
    });

    const res = await app.request(PATH, testEvalInit("cp-app-A"));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      variantName: "treatment",
      value: true,
      liveRunId: null,
      resolutionReason: "TARGETING_MATCH",
      reason: {
        type: "rule_matched",
        ruleId: "rule-enterprise",
        ruleName: null,
        priority: 0,
        selection: "direct",
        rollout: null,
      },
    });
    expect(configKv.getCalls).toEqual([
      flagConfigKey(APP_ID, ENVIRONMENT_ID, FLAG_KEY),
      experimentConfigKey(APP_ID, ENVIRONMENT_ID, EXPERIMENT_ID),
    ]);
    expect(assignmentStore.putCalls).toEqual([]);
  });

  it("repeated dry-runs leave Assignment Store unchanged", async () => {
    const { app, assignmentStore } = makeHarness();

    await app.request(PATH, testEvalInit("cp-app-A"));
    await app.request(PATH, testEvalInit("cp-app-A"));

    expect(assignmentStore.getAllCalls).toHaveLength(2);
    expect(assignmentStore.putCalls).toEqual([]);
  });

  it("returns a generic FLAG_NOT_FOUND without leaking KV key material", async () => {
    const { app, assignmentStore } = makeHarness();

    const res = await app.request(
      `/apps/${APP_ID}/envs/${ENVIRONMENT_ID}/flags/missing/test-eval`,
      testEvalInit("cp-app-A"),
    );
    const body = (await res.json()) as ErrorResponse;

    expect(res.status).toBe(404);
    expect(body).toEqual({ code: "FLAG_NOT_FOUND", message: "flag not found", details: {} });
    expect(JSON.stringify(body)).not.toContain("app:");
    expect(assignmentStore.getAllCalls).toEqual([]);
    expect(assignmentStore.putCalls).toEqual([]);
  });

  it("names the id-vs-key near miss when a Flag id is passed to this key-addressed route", async () => {
    // `flags create` prints a Flag id, and this is the next command an agent
    // runs. A bare "flag not found" sends it looking for a deleted Flag instead
    // of at the identifier it just pasted.
    const { app } = makeHarness();

    const res = await app.request(
      `/apps/${APP_ID}/envs/${ENVIRONMENT_ID}/flags/flag_01HZ/test-eval`,
      testEvalInit("cp-app-A"),
    );
    const body = (await res.json()) as ErrorResponse;

    expect(res.status).toBe(404);
    expect(body.code).toBe("FLAG_NOT_FOUND");
    expect(body.message).toContain("takes a Flag key");
    expect(body.message).toContain("flag_01HZ");
  });

  it("rejects missing, data-plane, and cross-App credentials before evaluation", async () => {
    const { app, assignmentStore } = makeHarness();

    const missing = await app.request(PATH, testEvalInit());
    const clientKey = await app.request(PATH, testEvalInit("ck_test_123"));
    const apiKey = await app.request(PATH, testEvalInit("sk_test_123"));
    const otherApp = await app.request(PATH, testEvalInit("cp-other-app"));

    expect(missing.status).toBe(401);
    expect(((await missing.json()) as ErrorResponse).code).toBe("UNAUTHORIZED");
    expect(clientKey.status).toBe(401);
    expect(((await clientKey.json()) as ErrorResponse).code).toBe("UNAUTHORIZED");
    expect(apiKey.status).toBe(401);
    expect(((await apiKey.json()) as ErrorResponse).code).toBe("UNAUTHORIZED");
    expect(otherApp.status).toBe(403);
    expect(((await otherApp.json()) as ErrorResponse).code).toBe("FORBIDDEN");
    expect(assignmentStore.getAllCalls).toEqual([]);
    expect(assignmentStore.putCalls).toEqual([]);
  });
});

class TestEvalPausingSaltStore extends StaticSaltStore {
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

  override async currentKeyVersion(): Promise<string> {
    this.calls += 1;
    if (this.calls === 3) {
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
