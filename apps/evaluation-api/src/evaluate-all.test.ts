import {
  clientKeyCacheKey,
  CredentialCacheKVSchema,
  flagConfigKey,
  type ErrorResponse,
  type EvaluateAllResponse,
} from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { targetingRule } from "./evaluate/evaluate-path-test-fixtures";
import { flagConfigKV } from "./provider/fixtures";
import {
  API_KEY,
  APP_ID,
  CLIENT_KEY,
  ENVIRONMENT_ID,
  EXPERIMENT_ID,
  FLAG_KEY,
  LOCKED_CLIENT_KEY,
  REVOKED_CLIENT_KEY,
  UNSCOPED_API_KEY,
  evaluateAllRouteInit,
  makeSdkRouteHarness,
  sha256Hex,
} from "./sdk-route-test-fixtures";

const PATH = "/api/sdk/evaluate-all";
const APP_B = "app-B";
const CLIENT_KEY_B = "pk_evaluate_all_app_b";

describe("POST /api/sdk/evaluate-all: response contract", () => {
  it("returns non-revealing Precomputed Evaluations under both credential tiers", async () => {
    const { app, assignmentStore } = await makeSdkRouteHarness({ liveRun: true });

    const client = await app.request(PATH, evaluateAllRouteInit(CLIENT_KEY));
    const api = await app.request(PATH, evaluateAllRouteInit(API_KEY));
    const clientBody = (await client.json()) as EvaluateAllResponse;
    const apiBody = (await api.json()) as EvaluateAllResponse;

    expect(client.status).toBe(200);
    expect(api.status).toBe(200);
    expect(clientBody.evaluations[FLAG_KEY]?.reason).toBe("SPLIT");
    expect(apiBody.evaluations[FLAG_KEY]?.reason).toBe("SPLIT");
    // Destination-fixed: API Key does NOT receive TARGETING_MATCH / ruleId.
    expect(apiBody.evaluations[FLAG_KEY]).not.toHaveProperty("ruleId");
    expect(JSON.stringify(clientBody)).not.toContain("TARGETING_MATCH");
    expect(JSON.stringify(apiBody)).not.toContain("TARGETING_MATCH");
    expect(assignmentStore.putCalls).toEqual([]);
  });

  it("asserts the wire shape contains only ResolutionDetails fields and the integrity token", async () => {
    const { app } = await makeSdkRouteHarness({ liveRun: true });

    const res = await app.request(PATH, evaluateAllRouteInit(CLIENT_KEY));
    const raw = await res.text();
    const body = JSON.parse(raw) as EvaluateAllResponse;
    const entry = body.evaluations[FLAG_KEY];

    expect(res.status).toBe(200);
    expect(entry).toEqual({
      variant: expect.any(Boolean),
      variantName: expect.any(String),
      reason: "SPLIT",
      errorCode: null,
      exposureTicket: expect.any(String),
    });
    expect(Object.keys(entry ?? {}).sort()).toEqual([
      "errorCode",
      "exposureTicket",
      "reason",
      "variant",
      "variantName",
    ]);
    expect(raw).not.toContain("rule-enterprise");
    expect(raw).not.toContain("rollout");
    expect(raw).not.toContain("salt");
    expect(raw).not.toContain("run-salt");
    expect(raw).not.toContain("targetingRules");
    expect(raw).not.toContain("allocation");
  });

  it("mints an Exposure Ticket only for fresh live-Run assignments", async () => {
    const fresh = await makeSdkRouteHarness({ liveRun: true });
    const holdover = await makeSdkRouteHarness({
      liveRun: true,
      holdovers: new Map([[EXPERIMENT_ID, { runId: "run-prior", variant: "treatment" }]]),
    });
    const disabled = await makeSdkRouteHarness({
      flagOverrides: { enabled: false },
    });

    const freshBody = (await (
      await fresh.app.request(PATH, evaluateAllRouteInit(CLIENT_KEY))
    ).json()) as EvaluateAllResponse;
    const holdoverBody = (await (
      await holdover.app.request(PATH, evaluateAllRouteInit(CLIENT_KEY))
    ).json()) as EvaluateAllResponse;
    const disabledBody = (await (
      await disabled.app.request(PATH, evaluateAllRouteInit(CLIENT_KEY))
    ).json()) as EvaluateAllResponse;

    expect(freshBody.evaluations[FLAG_KEY]?.exposureTicket).toEqual(expect.any(String));
    expect(holdoverBody.evaluations[FLAG_KEY]).toMatchObject({
      reason: "SPLIT",
      exposureTicket: null,
      variantName: "treatment",
    });
    expect(disabledBody.evaluations[FLAG_KEY]).toMatchObject({
      reason: "DISABLED",
      exposureTicket: null,
    });
    expect(fresh.assignmentStore.putCalls).toEqual([]);
    expect(holdover.assignmentStore.putCalls).toEqual([]);
  });

  it("keeps a per-Flag resolution failure in the payload as ERROR (ADR-0036)", async () => {
    const { app } = await makeSdkRouteHarness({ liveRun: true });

    const res = await app.request(
      PATH,
      evaluateAllRouteInit(CLIENT_KEY, {}, { idType: "session" }),
    );
    const body = (await res.json()) as EvaluateAllResponse;

    expect(res.status).toBe(200);
    expect(body.evaluations[FLAG_KEY]).toMatchObject({
      reason: "ERROR",
      errorCode: "VALIDATION_ERROR",
      exposureTicket: null,
    });
    expect(body.evaluations).toHaveProperty(FLAG_KEY);
  });
});

describe("POST /api/sdk/evaluate-all: ETag and tickets", () => {
  it("returns a stable ETag and 304 on If-None-Match", async () => {
    const harness = await makeSdkRouteHarness({ liveRun: true });

    const first = await harness.app.request(PATH, evaluateAllRouteInit(CLIENT_KEY));
    const etag = first.headers.get("etag");
    expect(first.status).toBe(200);
    expect(etag).toMatch(/^"[a-f0-9]{64}"$/);
    expect(harness.evaluationUsageSink.writes).toHaveLength(1);
    expect(harness.evaluationUsageSink.writes[0]).toMatchObject({
      evaluationCount: 1,
      isBatch: true,
      hasExposure: false,
    });

    const revalidate = await harness.app.request(
      PATH,
      evaluateAllRouteInit(CLIENT_KEY, { "if-none-match": etag ?? "" }),
    );
    expect(revalidate.status).toBe(304);
    expect(await revalidate.text()).toBe("");
    expect(revalidate.headers.get("etag")).toBe(etag);
    // 304 revalidations consume zero Evaluations.
    expect(harness.evaluationUsageSink.writes).toHaveLength(1);

    const changed = await makeSdkRouteHarness({
      liveRun: true,
      flagOverrides: { enabled: false },
    });
    const changedRes = await changed.app.request(PATH, evaluateAllRouteInit(CLIENT_KEY));
    expect(changedRes.headers.get("etag")).not.toBe(etag);
  });

  it("keeps ETag stable when Exposure Ticket issued_at advances", async () => {
    const early = await makeSdkRouteHarness({
      liveRun: true,
      ticketNow: () => new Date("2026-07-03T00:00:00.000Z"),
    });
    const late = await makeSdkRouteHarness({
      liveRun: true,
      ticketNow: () => new Date("2026-07-04T00:00:00.000Z"),
    });

    const first = await early.app.request(PATH, evaluateAllRouteInit(CLIENT_KEY));
    const second = await late.app.request(PATH, evaluateAllRouteInit(CLIENT_KEY));
    const firstBody = (await first.json()) as EvaluateAllResponse;
    const secondBody = (await second.json()) as EvaluateAllResponse;

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.headers.get("etag")).toBe(second.headers.get("etag"));
    expect(firstBody.evaluations[FLAG_KEY]?.exposureTicket).not.toBe(
      secondBody.evaluations[FLAG_KEY]?.exposureTicket,
    );

    const revalidate = await late.app.request(
      PATH,
      evaluateAllRouteInit(CLIENT_KEY, {
        "if-none-match": first.headers.get("etag") ?? "",
      }),
    );
    expect(revalidate.status).toBe(304);
    expect(late.evaluationUsageSink.writes).toHaveLength(1);
  });

  it("emits SPLIT + ticket for live-Run no-match defaults (evaluate would expose)", async () => {
    const { app } = await makeSdkRouteHarness({
      liveRun: true,
      runOverrides: {
        targetingRules: [
          targetingRule({
            id: "rule-enterprise",
            conditions: [{ attribute: "plan", operator: "eq", value: "enterprise" }],
          }),
        ],
      },
      flagOverrides: { targetingRules: [] },
    });

    const res = await app.request(
      PATH,
      evaluateAllRouteInit(CLIENT_KEY, {}, { attributes: { plan: "free" } }),
    );
    const body = (await res.json()) as EvaluateAllResponse;

    expect(res.status).toBe(200);
    expect(body.evaluations[FLAG_KEY]).toMatchObject({
      reason: "SPLIT",
      exposureTicket: expect.any(String),
      errorCode: null,
    });
  });
});

describe("POST /api/sdk/evaluate-all: isolation and side effects", () => {
  it("writes no Exposure and no Assignment Store put under either credential tier", async () => {
    const { app, assignmentStore, exposureSink, evaluationUsageSink } = await makeSdkRouteHarness({
      liveRun: true,
    });

    const client = await app.request(PATH, evaluateAllRouteInit(CLIENT_KEY));
    const api = await app.request(PATH, evaluateAllRouteInit(API_KEY));

    expect(client.status).toBe(200);
    expect(api.status).toBe(200);
    expect(exposureSink.writes).toEqual([]);
    expect(assignmentStore.putCalls).toEqual([]);
    expect(evaluationUsageSink.writes.every((write) => write.hasExposure === false)).toBe(true);
  });

  it("reads Assignment Store holdovers once per request", async () => {
    const secondFlag = "pricing-banner";
    const { app, assignmentStore, configKv } = await makeSdkRouteHarness({ liveRun: true });
    configKv.put(
      flagConfigKey(APP_ID, ENVIRONMENT_ID, secondFlag),
      flagConfigKV({
        id: "flag-id-2",
        key: secondFlag,
        experimentId: EXPERIMENT_ID,
        targetingRules: [targetingRule({ id: "rule-enterprise" })],
      }),
    );

    const res = await app.request(PATH, evaluateAllRouteInit(CLIENT_KEY));
    const body = (await res.json()) as EvaluateAllResponse;

    expect(res.status).toBe(200);
    expect(Object.keys(body.evaluations).sort()).toEqual([FLAG_KEY, secondFlag].sort());
    expect(assignmentStore.getAllCalls).toHaveLength(1);
  });

  it("rejects App B credentials from reading App A Flag keys (tenant isolation)", async () => {
    const { app, configKv, credentialKv, assignmentStore } = await makeSdkRouteHarness({
      liveRun: true,
    });
    credentialKv.put(
      clientKeyCacheKey(await sha256Hex(CLIENT_KEY_B)),
      CredentialCacheKVSchema.parse({
        appId: APP_B,
        environmentId: ENVIRONMENT_ID,
        credentialSchemaVersion: 2,
        organizationId: "org_b",
        kind: "client_key",
        scopes: ["data-plane:evaluate"],
        originAllowlist: null,
        rateLimitRps: null,
        revoked: false,
        cachedAt: "2026-07-02T00:00:00.000Z",
      }),
    );
    // App B has no flags seeded — payload must be empty, never App A's keys.
    const res = await app.request(PATH, evaluateAllRouteInit(CLIENT_KEY_B));
    const body = (await res.json()) as EvaluateAllResponse;

    expect(res.status).toBe(200);
    expect(body.evaluations).toEqual({});
    expect(JSON.stringify(body)).not.toContain(FLAG_KEY);
    expect(configKv.getCalls.every((key) => !key.includes(`app:${APP_ID}:`))).toBe(true);
    expect(assignmentStore.putCalls).toEqual([]);

    const mismatch = await app.request(
      PATH,
      evaluateAllRouteInit(CLIENT_KEY_B, {}, { appId: APP_ID }),
    );
    expect(mismatch.status).toBe(403);
    expect(((await mismatch.json()) as ErrorResponse).code).toBe("APP_MISMATCH");
  });

  it("rejects revoked credentials with CREDENTIAL_REVOKED before evaluation", async () => {
    const { app, assignmentStore } = await makeSdkRouteHarness();

    const revoked = await app.request(PATH, evaluateAllRouteInit(REVOKED_CLIENT_KEY));

    expect(revoked.status).toBe(403);
    expect(((await revoked.json()) as ErrorResponse).code).toBe("CREDENTIAL_REVOKED");
    expect(assignmentStore.getAllCalls).toEqual([]);
  });

  it("enforces Client Key origin allow-list before evaluation", async () => {
    const blocked = await makeSdkRouteHarness();
    const res = await blocked.app.request(
      PATH,
      evaluateAllRouteInit(LOCKED_CLIENT_KEY, { origin: "https://evil.example.test" }),
    );

    expect(res.status).toBe(403);
    expect(((await res.json()) as ErrorResponse).code).toBe("ORIGIN_NOT_ALLOWED");
    expect(blocked.assignmentStore.getAllCalls).toEqual([]);
  });

  it("rejects an API Key without data-plane:evaluate before evaluation", async () => {
    const { app, assignmentStore } = await makeSdkRouteHarness();

    const res = await app.request(PATH, evaluateAllRouteInit(UNSCOPED_API_KEY));

    expect(res.status).toBe(403);
    expect(((await res.json()) as ErrorResponse).code).toBe("INSUFFICIENT_SCOPES");
    expect(assignmentStore.getAllCalls).toEqual([]);
  });
});
