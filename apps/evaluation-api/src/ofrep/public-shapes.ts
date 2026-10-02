import { flagConfigKey } from "@splitch/contracts";
import { makeEvaluationRateLimiter } from "../evaluation-rate-limit";
import { flagConfigKV } from "../provider/fixtures";
import {
  APP_ID,
  CLIENT_KEY,
  ENVIRONMENT_ID,
  FLAG_KEY,
  LOCKED_CLIENT_KEY,
  makeSdkRouteHarness,
  REVOKED_CLIENT_KEY,
  UNSCOPED_API_KEY,
} from "../sdk-route-test-fixtures";

export function ofrepInit(
  credential?: string,
  extraHeaders: Record<string, string> = {},
  context: Record<string, unknown> = { targetingKey: "user-1", idType: "user" },
): RequestInit {
  return {
    method: "POST",
    headers: {
      ...(credential === undefined ? {} : { authorization: `Bearer ${credential}` }),
      "content-type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify({ context }),
  };
}

export async function produceOfrepEvaluate(): Promise<{
  success: unknown;
  errors: Record<string, unknown>;
}> {
  const path = `/ofrep/v1/evaluate/flags/${FLAG_KEY}`;
  const { app } = await makeSdkRouteHarness({
    liveRun: true,
    runOverrides: { allocation: { control: 0, treatment: 100 }, targetingRules: [] },
  });
  const success = await (await app.request(path, ofrepInit(CLIENT_KEY))).json();
  const errors = await ofrepAuthErrors(path);
  errors.INSUFFICIENT_SCOPES = await (await app.request(path, ofrepInit(UNSCOPED_API_KEY))).json();
  errors.FLAG_NOT_FOUND = await (
    await app.request("/ofrep/v1/evaluate/flags/missing-flag", ofrepInit(CLIENT_KEY))
  ).json();
  // Context shape failures are OFREP INVALID_CONTEXT / PARSE_ERROR. Body-byte-limit
  // refusals still use the splitch VALIDATION_ERROR envelope.
  errors.VALIDATION_ERROR = await (
    await app.request(path, {
      method: "POST",
      headers: { authorization: `Bearer ${CLIENT_KEY}`, "content-type": "application/json" },
      body: "x".repeat(33 * 1024),
    })
  ).json();
  const { app: legacy } = await makeSdkRouteHarness({ liveRun: true, legacyClientKey: true });
  errors.SERVICE_UNAVAILABLE = await (await legacy.request(path, ofrepInit(CLIENT_KEY))).json();
  return { success, errors };
}

export async function produceOfrepEvaluateBulk(): Promise<{
  success: unknown;
  errors: Record<string, unknown>;
}> {
  const path = "/ofrep/v1/evaluate/flags";
  const { app } = await makeSdkRouteHarness();
  const success = await (await app.request(path, ofrepInit(CLIENT_KEY))).json();
  const errors = await ofrepAuthErrors(path);
  errors.INSUFFICIENT_SCOPES = await (await app.request(path, ofrepInit(UNSCOPED_API_KEY))).json();
  errors.VALIDATION_ERROR = await (
    await app.request(path, {
      method: "POST",
      headers: { authorization: `Bearer ${CLIENT_KEY}`, "content-type": "application/json" },
      body: "x".repeat(33 * 1024),
    })
  ).json();
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
  errors.UNSUPPORTED_OBJECT_KEY = await (
    await proto.app.request(path, ofrepInit(CLIENT_KEY))
  ).json();
  const { app: legacy } = await makeSdkRouteHarness({ legacyClientKey: true });
  errors.SERVICE_UNAVAILABLE = await (await legacy.request(path, ofrepInit(CLIENT_KEY))).json();
  return { success, errors };
}

async function ofrepAuthErrors(path: string): Promise<Record<string, unknown>> {
  const { app } = await makeSdkRouteHarness({ liveRun: true });
  const { app: limited } = await makeSdkRouteHarness({
    liveRun: true,
    rateLimiter: makeEvaluationRateLimiter({ limit: async () => ({ success: false }) }),
  });
  return {
    UNAUTHORIZED: await (await app.request(path, ofrepInit())).json(),
    UNSUPPORTED_MEDIA_TYPE: await (
      await app.request(path, ofrepInit(CLIENT_KEY, { "content-type": "text/plain" }))
    ).json(),
    CREDENTIAL_REVOKED: await (await app.request(path, ofrepInit(REVOKED_CLIENT_KEY))).json(),
    ORIGIN_NOT_ALLOWED: await (
      await app.request(path, ofrepInit(LOCKED_CLIENT_KEY, { origin: "https://denied.example" }))
    ).json(),
    RATE_LIMITED: await (await limited.request(path, ofrepInit(CLIENT_KEY))).json(),
  };
}
