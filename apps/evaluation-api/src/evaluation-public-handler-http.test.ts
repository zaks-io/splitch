import {
  ErrorResponseSchema,
  ExposureBatchResponseSchema,
  flagConfigKey,
  getRoute,
} from "@splitch/contracts";
import { ProviderError } from "@splitch/evaluation-core";
import { describe, expect, it } from "vitest";
import { makeEvaluationRateLimiter } from "./evaluation-rate-limit";
import { MemoryExposureRedemptionClaimStore } from "./exposure-redemption-claim";
import type { ExposureRedemptionClaimStore } from "./exposure-redemption-claim-core";
import {
  EXPOSURE_ID_A,
  exposuresInit,
  mintTicket,
  PATH as EXPOSURES_PATH,
} from "./exposures-test-fixtures";
import { flagConfigKV } from "./provider/fixtures";
import {
  APP_ID,
  CLIENT_KEY,
  ENVIRONMENT_ID,
  evaluateAllRouteInit,
  FLAG_KEY,
  LOCKED_CLIENT_KEY,
  makeSdkRouteHarness,
  REVOKED_CLIENT_KEY,
  sdkRouteInit,
  UNSCOPED_API_KEY,
} from "./sdk-route-test-fixtures";

const EVALUATE = "/api/sdk/evaluate";
const VERIFY = "/api/sdk/verify";
const EVALUATE_ALL = "/api/sdk/evaluate-all";
const TELEMETRY = "/api/sdk/evaluation-telemetry";
const DENIED = { origin: "https://denied.example" };

type App = Awaited<ReturnType<typeof makeSdkRouteHarness>>["app"];

async function posted(app: App, path: string, init: RequestInit) {
  const res = await app.request(path, init);
  return { status: res.status, body: await res.json() };
}

function topLevelCode(status: number, body: unknown): string {
  expect(status).toBeGreaterThanOrEqual(400);
  return ErrorResponseSchema.parse(body).code;
}

function withoutIdempotency(init: RequestInit): RequestInit {
  const headers = new Headers(init.headers);
  headers.delete("idempotency-key");
  return { ...init, headers };
}

function limited() {
  return makeSdkRouteHarness({
    rateLimiter: makeEvaluationRateLimiter({ limit: async () => ({ success: false }) }),
  });
}

function telemetryInit(
  credential?: string,
  extraHeaders: Record<string, string> = {},
  body: Record<string, unknown> = { flagKey: FLAG_KEY, idempotencyKey: "cache-hit-1" },
): RequestInit {
  return {
    method: "POST",
    headers: {
      ...(credential === undefined ? {} : { authorization: `Bearer ${credential}` }),
      "content-type": "application/json",
      "idempotency-key": "cache-hit-1",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

async function produceEvaluateCodes(): Promise<string[]> {
  const { app } = await makeSdkRouteHarness();
  const revoked = await makeSdkRouteHarness();
  const rate = await limited();
  const legacy = await makeSdkRouteHarness({ legacyClientKey: true });
  const hits = [
    await posted(app, EVALUATE, sdkRouteInit()),
    await posted(revoked.app, EVALUATE, sdkRouteInit(REVOKED_CLIENT_KEY)),
    await posted(app, EVALUATE, sdkRouteInit(CLIENT_KEY, {}, { appId: "app-other" })),
    await posted(app, EVALUATE, sdkRouteInit(LOCKED_CLIENT_KEY, DENIED)),
    await posted(app, EVALUATE, sdkRouteInit(CLIENT_KEY, {}, { flagKey: "missing-flag" })),
    await posted(app, EVALUATE, withoutIdempotency(sdkRouteInit(CLIENT_KEY))),
    await posted(rate.app, EVALUATE, sdkRouteInit(CLIENT_KEY)),
    await posted(legacy.app, EVALUATE, sdkRouteInit(CLIENT_KEY)),
  ];
  return hits.map((hit) => topLevelCode(hit.status, hit.body));
}

async function produceVerifyCodes(): Promise<string[]> {
  const { app } = await makeSdkRouteHarness();
  const down = await makeSdkRouteHarness();
  down.configKv.getError = new ProviderError("kv down", { errorCode: "SERVICE_UNAVAILABLE" });
  const rate = await limited();
  const hits = [
    await posted(app, VERIFY, sdkRouteInit()),
    await posted(app, VERIFY, sdkRouteInit(REVOKED_CLIENT_KEY)),
    await posted(app, VERIFY, sdkRouteInit(UNSCOPED_API_KEY)),
    await posted(app, VERIFY, sdkRouteInit(CLIENT_KEY, {}, { appId: "app-other" })),
    await posted(app, VERIFY, sdkRouteInit(LOCKED_CLIENT_KEY, DENIED)),
    await posted(app, VERIFY, sdkRouteInit(CLIENT_KEY, {}, { flagKey: "missing-flag" })),
    await posted(
      (await makeSdkRouteHarness({ experimentOverrides: { targetingKeyType: "workspace" } })).app,
      VERIFY,
      sdkRouteInit(CLIENT_KEY),
    ),
    await posted(rate.app, VERIFY, sdkRouteInit(CLIENT_KEY)),
    await posted(down.app, VERIFY, sdkRouteInit(CLIENT_KEY)),
  ];
  return hits.map((hit) => topLevelCode(hit.status, hit.body));
}

async function produceEvaluateAllCodes(): Promise<string[]> {
  const { app, configKv } = await makeSdkRouteHarness({ liveRun: true });
  configKv.put(
    flagConfigKey(APP_ID, ENVIRONMENT_ID, "__proto__"),
    flagConfigKV({
      id: "flag-id-proto",
      key: "__proto__",
      experimentId: null,
      targetingRules: [],
      rollout: null,
    }),
  );
  const rate = await limited();
  const legacy = await makeSdkRouteHarness({ liveRun: true, legacyClientKey: true });
  const hits = [
    await posted(app, EVALUATE_ALL, evaluateAllRouteInit()),
    await posted(app, EVALUATE_ALL, evaluateAllRouteInit(REVOKED_CLIENT_KEY)),
    await posted(app, EVALUATE_ALL, evaluateAllRouteInit(UNSCOPED_API_KEY)),
    await posted(app, EVALUATE_ALL, evaluateAllRouteInit(CLIENT_KEY, {}, { appId: "app-other" })),
    await posted(app, EVALUATE_ALL, evaluateAllRouteInit(LOCKED_CLIENT_KEY, DENIED)),
    await posted(app, EVALUATE_ALL, withoutIdempotency(evaluateAllRouteInit(CLIENT_KEY))),
    await posted(app, EVALUATE_ALL, evaluateAllRouteInit(CLIENT_KEY)),
    await posted(rate.app, EVALUATE_ALL, evaluateAllRouteInit(CLIENT_KEY)),
    await posted(legacy.app, EVALUATE_ALL, evaluateAllRouteInit(CLIENT_KEY)),
  ];
  return hits.map((hit) => topLevelCode(hit.status, hit.body));
}

async function produceTelemetryCodes(): Promise<string[]> {
  const { app } = await makeSdkRouteHarness();
  const rate = await limited();
  const legacy = await makeSdkRouteHarness({ legacyClientKey: true });
  const hits = [
    await posted(app, TELEMETRY, telemetryInit()),
    await posted(app, TELEMETRY, telemetryInit(REVOKED_CLIENT_KEY)),
    await posted(app, TELEMETRY, telemetryInit(LOCKED_CLIENT_KEY, DENIED)),
    await posted(
      app,
      TELEMETRY,
      telemetryInit(
        CLIENT_KEY,
        { "idempotency-key": "cache-hit-header" },
        {
          flagKey: FLAG_KEY,
          idempotencyKey: "cache-hit-body",
        },
      ),
    ),
    await posted(rate.app, TELEMETRY, telemetryInit(CLIENT_KEY)),
    await posted(legacy.app, TELEMETRY, telemetryInit(CLIENT_KEY)),
  ];
  return hits.map((hit) => topLevelCode(hit.status, hit.body));
}

async function produceExposureCodes(): Promise<string[]> {
  const { app } = await makeSdkRouteHarness({ liveRun: true });
  const rate = await limited();
  const legacy = await makeSdkRouteHarness({ liveRun: true, legacyClientKey: true });
  const claims = new MemoryExposureRedemptionClaimStore();
  const conflict = await makeSdkRouteHarness({ liveRun: true, exposureRedemptionClaims: claims });
  const expired = await makeSdkRouteHarness({
    liveRun: true,
    ticketNow: () => new Date("2026-07-05T00:00:00.000Z"),
  });
  const faultStore: ExposureRedemptionClaimStore = {
    claim: async () => {
      throw new TypeError("undefined is not a function");
    },
    release: async () => undefined,
    markSealed: async () => undefined,
    acknowledge: async () => ({ status: "accepted" }),
  };
  const fault = await makeSdkRouteHarness({ liveRun: true, exposureRedemptionClaims: faultStore });
  const firstTicket = await mintTicket({ targetingKey: "user-1" });
  const secondTicket = await mintTicket({ targetingKey: "user-2" });
  const wellFormed = [{ exposureId: EXPOSURE_ID_A, exposureTicket: firstTicket }];
  await conflict.app.request(EXPOSURES_PATH, exposuresInit(CLIENT_KEY, wellFormed));
  const forged = `${(await mintTicket()).split(".")[0]}.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`;
  const top = [
    await posted(app, EXPOSURES_PATH, exposuresInit(undefined, wellFormed)),
    await posted(app, EXPOSURES_PATH, exposuresInit(REVOKED_CLIENT_KEY, wellFormed)),
    await posted(app, EXPOSURES_PATH, exposuresInit(UNSCOPED_API_KEY, wellFormed)),
    await posted(app, EXPOSURES_PATH, exposuresInit(LOCKED_CLIENT_KEY, wellFormed, DENIED)),
    await posted(app, EXPOSURES_PATH, exposuresInit(CLIENT_KEY, [])),
    await posted(rate.app, EXPOSURES_PATH, exposuresInit(CLIENT_KEY, wellFormed)),
    await posted(legacy.app, EXPOSURES_PATH, exposuresInit(CLIENT_KEY, wellFormed)),
  ].map((hit) => topLevelCode(hit.status, hit.body));
  const items = [
    await posted(
      app,
      EXPOSURES_PATH,
      exposuresInit(CLIENT_KEY, [{ exposureId: EXPOSURE_ID_A, exposureTicket: forged }]),
    ),
    await posted(
      expired.app,
      EXPOSURES_PATH,
      exposuresInit(CLIENT_KEY, [
        {
          exposureId: EXPOSURE_ID_A,
          exposureTicket: await mintTicket({ issuedAt: "2026-07-03T00:00:00.000Z" }),
        },
      ]),
    ),
    await posted(
      conflict.app,
      EXPOSURES_PATH,
      exposuresInit(CLIENT_KEY, [{ exposureId: EXPOSURE_ID_A, exposureTicket: secondTicket }]),
    ),
    await posted(
      fault.app,
      EXPOSURES_PATH,
      exposuresInit(CLIENT_KEY, [
        { exposureId: EXPOSURE_ID_A, exposureTicket: await mintTicket() },
      ]),
    ),
  ].map((hit) => {
    expect(hit.status).toBe(202);
    return ExposureBatchResponseSchema.parse(hit.body).results[0]?.code;
  });
  return [...top, ...items].filter((code): code is string => code !== undefined && code !== null);
}

describe("evaluation public handler HTTP", () => {
  it("sdk_evaluate produces every declared handler error at HTTP", async () => {
    expect((await produceEvaluateCodes()).sort()).toEqual(
      [...(getRoute("sdk_evaluate")?.errors ?? [])].sort(),
    );
  });

  it("sdk_verify produces every declared handler error at HTTP", async () => {
    expect((await produceVerifyCodes()).sort()).toEqual(
      [...(getRoute("sdk_verify")?.errors ?? [])].sort(),
    );
  });

  it("sdk_evaluate_all produces every declared handler error at HTTP", async () => {
    expect((await produceEvaluateAllCodes()).sort()).toEqual(
      [...(getRoute("sdk_evaluate_all")?.errors ?? [])].sort(),
    );
  });

  it("sdk_cached_evaluation_telemetry produces every declared handler error at HTTP", async () => {
    expect((await produceTelemetryCodes()).sort()).toEqual(
      [...(getRoute("sdk_cached_evaluation_telemetry")?.errors ?? [])].sort(),
    );
  });

  it("sdk_exposures produces every declared handler error at HTTP", async () => {
    expect([...(await produceExposureCodes())].sort()).toEqual(
      [...(getRoute("sdk_exposures")?.errors ?? [])].sort(),
    );
  });

  it("produces contract-valid success bodies for the four public routes", async () => {
    const { app } = await makeSdkRouteHarness({ liveRun: true });
    const verify = await posted(app, VERIFY, sdkRouteInit(CLIENT_KEY));
    const all = await posted(app, EVALUATE_ALL, evaluateAllRouteInit(CLIENT_KEY));
    const telemetry = await posted(app, TELEMETRY, telemetryInit(CLIENT_KEY));
    const accepted = await posted(
      app,
      EXPOSURES_PATH,
      exposuresInit(CLIENT_KEY, [
        { exposureId: EXPOSURE_ID_A, exposureTicket: await mintTicket() },
      ]),
    );
    expect(verify.status).toBe(200);
    expect(all.status).toBe(200);
    expect(telemetry.status).toBe(200);
    expect(accepted.status).toBe(202);
    getRoute("sdk_verify")?.output.parse(verify.body);
    getRoute("sdk_evaluate_all")?.output.parse(all.body);
    getRoute("sdk_cached_evaluation_telemetry")?.output.parse(telemetry.body);
    getRoute("sdk_exposures")?.output.parse(accepted.body);
    const raw = JSON.stringify([verify.body, all.body, telemetry.body, accepted.body]);
    expect(raw).not.toContain("ruleId");
    expect(raw).not.toContain("TARGETING_MATCH");
    expect(raw).not.toContain("eventDefinitionId");
    expect(raw).not.toContain("eventDefinitionVersionId");
    expect(raw).not.toMatch(/sk_live_|ck_/);
  });
});
