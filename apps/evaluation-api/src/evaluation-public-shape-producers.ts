import { flagConfigKey, routeRegistry } from "@splitch/contracts";
import { ProviderError } from "@splitch/evaluation-core";
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

export const EVALUATION_CLIENT_KEY_ROUTES = routeRegistry.filter(
  (route) =>
    route.owner === "evaluation-api" &&
    (route.auth === "client-key" || route.auth === "data-plane-key"),
);

type Produced = { success: unknown; errors: Record<string, unknown> };

const PRODUCERS: Record<string, () => Promise<Produced>> = {
  sdk_evaluate: produceEvaluate,
  sdk_verify: produceVerify,
  sdk_evaluate_all: produceEvaluateAll,
  sdk_cached_evaluation_telemetry: produceTelemetry,
  sdk_exposures: produceExposures,
};

export async function produceEvaluationClientKeyShapes(): Promise<Record<string, Produced>> {
  const produced: Record<string, Produced> = {};
  for (const route of EVALUATION_CLIENT_KEY_ROUTES) {
    const producer = PRODUCERS[route.operationId];
    if (producer === undefined) throw new Error(`no HTTP producer for ${route.operationId}`);
    produced[route.operationId] = await producer();
  }
  return produced;
}

async function produceEvaluate(): Promise<Produced> {
  const path = "/api/sdk/evaluate";
  const { app } = await makeSdkRouteHarness({
    liveRun: true,
    runOverrides: { allocation: { control: 0, treatment: 100 }, targetingRules: [] },
  });
  const success = await jsonOf(await app.request(path, sdkRouteInit(CLIENT_KEY)));
  const errors = await commonAuthOriginRateLimit(path, sdkRouteInit);
  errors.APP_MISMATCH = await jsonOf(
    await app.request(path, sdkRouteInit(CLIENT_KEY, {}, { appId: "app-other" })),
  );
  errors.FLAG_NOT_FOUND = await jsonOf(
    await app.request(path, sdkRouteInit(CLIENT_KEY, {}, { flagKey: "missing-flag" })),
  );
  errors.VALIDATION_ERROR = await jsonOf(
    await app.request(path, withoutIdempotency(sdkRouteInit(CLIENT_KEY))),
  );
  const { app: legacy } = await makeSdkRouteHarness({ liveRun: true, legacyClientKey: true });
  errors.SERVICE_UNAVAILABLE = await jsonOf(await legacy.request(path, sdkRouteInit(CLIENT_KEY)));
  return { success, errors };
}

async function produceVerify(): Promise<Produced> {
  const path = "/api/sdk/verify";
  const { app } = await makeSdkRouteHarness();
  const success = await jsonOf(await app.request(path, sdkRouteInit(CLIENT_KEY)));
  const errors = await commonAuthOriginRateLimit(path, sdkRouteInit);
  errors.INSUFFICIENT_SCOPES = await jsonOf(
    await app.request(path, sdkRouteInit(UNSCOPED_API_KEY)),
  );
  errors.APP_MISMATCH = await jsonOf(
    await app.request(path, sdkRouteInit(CLIENT_KEY, {}, { appId: "app-other" })),
  );
  errors.FLAG_NOT_FOUND = await jsonOf(
    await app.request(path, sdkRouteInit(CLIENT_KEY, {}, { flagKey: "missing-flag" })),
  );
  errors.VALIDATION_ERROR = await jsonOf(
    await (
      await makeSdkRouteHarness({ experimentOverrides: { targetingKeyType: "workspace" } })
    ).app.request(path, sdkRouteInit(CLIENT_KEY)),
  );
  const down = await makeSdkRouteHarness();
  down.configKv.getError = new ProviderError("kv down", { errorCode: "SERVICE_UNAVAILABLE" });
  errors.SERVICE_UNAVAILABLE = await jsonOf(await down.app.request(path, sdkRouteInit(CLIENT_KEY)));
  return { success, errors };
}

async function produceEvaluateAll(): Promise<Produced> {
  const path = "/api/sdk/evaluate-all";
  const { app } = await makeSdkRouteHarness();
  const success = await jsonOf(await app.request(path, evaluateAllRouteInit(CLIENT_KEY)));
  const errors = await commonAuthOriginRateLimit(path, evaluateAllRouteInit);
  errors.INSUFFICIENT_SCOPES = await jsonOf(
    await app.request(path, evaluateAllRouteInit(UNSCOPED_API_KEY)),
  );
  errors.APP_MISMATCH = await jsonOf(
    await app.request(path, evaluateAllRouteInit(CLIENT_KEY, {}, { appId: "app-other" })),
  );
  errors.VALIDATION_ERROR = await jsonOf(
    await app.request(path, withoutIdempotency(evaluateAllRouteInit(CLIENT_KEY))),
  );
  const proto = await makeSdkRouteHarness();
  proto.configKv.put(
    flagConfigKey(APP_ID, ENVIRONMENT_ID, "__proto__"),
    flagConfigKV({
      id: "flag-id-proto",
      key: "__proto__",
      experimentId: null,
      targetingRules: [],
      rollout: null,
    }),
  );
  errors.UNSUPPORTED_OBJECT_KEY = await jsonOf(
    await proto.app.request(path, evaluateAllRouteInit(CLIENT_KEY)),
  );
  const { app: legacy } = await makeSdkRouteHarness({ legacyClientKey: true });
  errors.SERVICE_UNAVAILABLE = await jsonOf(
    await legacy.request(path, evaluateAllRouteInit(CLIENT_KEY)),
  );
  return { success, errors };
}

async function produceTelemetry(): Promise<Produced> {
  const path = "/api/sdk/evaluation-telemetry";
  const { app } = await makeSdkRouteHarness();
  const success = await jsonOf(await app.request(path, telemetryInit(CLIENT_KEY)));
  const errors = await commonAuthOriginRateLimit(path, telemetryInit);
  errors.VALIDATION_ERROR = await jsonOf(
    await app.request(path, telemetryInit(CLIENT_KEY, {}, { idempotencyKey: "cache-hit-body" })),
  );
  const { app: legacy } = await makeSdkRouteHarness({ legacyClientKey: true });
  errors.SERVICE_UNAVAILABLE = await jsonOf(await legacy.request(path, telemetryInit(CLIENT_KEY)));
  return { success, errors };
}

async function produceExposures(): Promise<Produced> {
  const path = EXPOSURES_PATH;
  const firstTicket = await mintTicket({ targetingKey: "user-1" });
  const wellFormed = [{ exposureId: EXPOSURE_ID_A, exposureTicket: firstTicket }];
  const { app } = await makeSdkRouteHarness({ liveRun: true });
  const success = await jsonOf(await app.request(path, exposuresInit(CLIENT_KEY, wellFormed)));
  const errors = await commonAuthOriginRateLimit(path, (credential, headers) =>
    exposuresInit(credential, wellFormed, headers ?? {}),
  );
  errors.INSUFFICIENT_SCOPES = await jsonOf(
    await app.request(path, exposuresInit(UNSCOPED_API_KEY, wellFormed)),
  );
  errors.VALIDATION_ERROR = await jsonOf(await app.request(path, exposuresInit(CLIENT_KEY, [])));
  const forged = `${(await mintTicket()).split(".")[0]}.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`;
  errors.EXPOSURE_TICKET_INVALID = await jsonOf(
    await app.request(
      path,
      exposuresInit(CLIENT_KEY, [{ exposureId: EXPOSURE_ID_A, exposureTicket: forged }]),
    ),
  );
  const expired = await makeSdkRouteHarness({
    liveRun: true,
    ticketNow: () => new Date("2026-07-05T00:00:00.000Z"),
  });
  errors.EXPOSURE_TICKET_EXPIRED = await jsonOf(
    await expired.app.request(
      path,
      exposuresInit(CLIENT_KEY, [
        {
          exposureId: EXPOSURE_ID_A,
          exposureTicket: await mintTicket({ issuedAt: "2026-07-03T00:00:00.000Z" }),
        },
      ]),
    ),
  );
  const claims = new MemoryExposureRedemptionClaimStore();
  const conflict = await makeSdkRouteHarness({ liveRun: true, exposureRedemptionClaims: claims });
  await conflict.app.request(path, exposuresInit(CLIENT_KEY, wellFormed));
  errors.EVENT_ID_CONFLICT = await jsonOf(
    await conflict.app.request(
      path,
      exposuresInit(CLIENT_KEY, [
        { exposureId: EXPOSURE_ID_A, exposureTicket: await mintTicket({ targetingKey: "user-2" }) },
      ]),
    ),
  );
  const { app: legacy } = await makeSdkRouteHarness({ liveRun: true, legacyClientKey: true });
  errors.SERVICE_UNAVAILABLE = await jsonOf(
    await legacy.request(path, exposuresInit(CLIENT_KEY, wellFormed)),
  );
  const faultStore: ExposureRedemptionClaimStore = {
    claim: async () => {
      throw new TypeError("undefined is not a function");
    },
    release: async () => undefined,
    markSealed: async () => undefined,
    acknowledge: async () => ({ status: "accepted" }),
  };
  const fault = await makeSdkRouteHarness({ liveRun: true, exposureRedemptionClaims: faultStore });
  errors.INTERNAL_SERVER_ERROR = await jsonOf(
    await fault.app.request(
      path,
      exposuresInit(CLIENT_KEY, [
        { exposureId: EXPOSURE_ID_A, exposureTicket: await mintTicket() },
      ]),
    ),
  );
  return { success, errors };
}

async function commonAuthOriginRateLimit(
  path: string,
  init: (
    credential?: string,
    headers?: Record<string, string>,
    body?: Record<string, unknown>,
  ) => RequestInit,
): Promise<Record<string, unknown>> {
  const { app } = await makeSdkRouteHarness({ liveRun: true });
  const { app: limited } = await makeSdkRouteHarness({
    liveRun: true,
    rateLimiter: makeEvaluationRateLimiter({ limit: async () => ({ success: false }) }),
  });
  return {
    UNAUTHORIZED: await jsonOf(await app.request(path, init())),
    CREDENTIAL_REVOKED: await jsonOf(await app.request(path, init(REVOKED_CLIENT_KEY))),
    ORIGIN_NOT_ALLOWED: await jsonOf(
      await app.request(path, init(LOCKED_CLIENT_KEY, { origin: "https://denied.example" })),
    ),
    RATE_LIMITED: await jsonOf(await limited.request(path, init(CLIENT_KEY))),
  };
}

function telemetryInit(
  credential?: string,
  extraHeaders: Record<string, string> = {},
  bodyOverrides: Record<string, unknown> = {},
): RequestInit {
  return {
    method: "POST",
    headers: {
      ...(credential === undefined ? {} : { authorization: `Bearer ${credential}` }),
      "content-type": "application/json",
      "idempotency-key": "cache-hit-1",
      ...extraHeaders,
    },
    body: JSON.stringify({ flagKey: FLAG_KEY, idempotencyKey: "cache-hit-1", ...bodyOverrides }),
  };
}

function withoutIdempotency(init: RequestInit): RequestInit {
  const headers = new Headers(init.headers);
  headers.delete("idempotency-key");
  return { ...init, headers };
}

async function jsonOf(response: Response): Promise<unknown> {
  return response.json();
}
