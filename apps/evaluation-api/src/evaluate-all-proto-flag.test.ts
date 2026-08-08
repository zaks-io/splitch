import { type ErrorResponse, flagConfigKey } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { flagConfigKV } from "./provider/fixtures";
import {
  APP_ID,
  CLIENT_KEY,
  ENVIRONMENT_ID,
  evaluateAllRouteInit,
  FLAG_KEY,
  makeSdkRouteHarness,
  sdkRouteInit,
} from "./sdk-route-test-fixtures";

const EVALUATE_ALL_PATH = "/api/sdk/evaluate-all";
const EVALUATE_PATH = "/api/sdk/evaluate";

describe("POST /api/sdk/evaluate-all: __proto__ Flag Key", () => {
  it("refuses with UNSUPPORTED_OBJECT_KEY when a Flag Key is __proto__", async () => {
    const protoFlag = "__proto__";
    const { app, configKv, evaluationUsageSink } = await makeSdkRouteHarness({ liveRun: true });
    configKv.put(
      flagConfigKey(APP_ID, ENVIRONMENT_ID, protoFlag),
      flagConfigKV({
        id: "flag-id-proto",
        key: protoFlag,
        experimentId: null,
        targetingRules: [],
        rollout: null,
      }),
    );

    const res = await app.request(EVALUATE_ALL_PATH, evaluateAllRouteInit(CLIENT_KEY));
    const body = (await res.json()) as ErrorResponse;

    expect(res.status).toBe(400);
    expect(body.code).toBe("UNSUPPORTED_OBJECT_KEY");
    if (body.code !== "UNSUPPORTED_OBJECT_KEY") {
      return;
    }
    expect(body.details).toEqual({
      key: "__proto__",
      path: ["evaluations", "__proto__"],
    });
    expect(body.message).toContain("__proto__");
    expect(JSON.stringify(body)).not.toContain(FLAG_KEY);
    expect(evaluationUsageSink.writes).toEqual([]);
  });
});

describe("data-plane evaluate: __proto__ attribute", () => {
  it("refuses evaluate-all when an attribute key is __proto__", async () => {
    const { app } = await makeSdkRouteHarness({ liveRun: true });
    const body = JSON.parse(
      '{"targetingKey":"user-1","idType":"user","attributes":{"__proto__":"evil","plan":"pro"}}',
    ) as Record<string, unknown>;

    const res = await app.request(EVALUATE_ALL_PATH, evaluateAllRouteInit(CLIENT_KEY, {}, body));
    const error = (await res.json()) as ErrorResponse;

    expect(res.status).toBe(400);
    expect(error.code).toBe("VALIDATION_ERROR");
    if (error.code !== "VALIDATION_ERROR") {
      return;
    }
    expect(error.details.issues.some((issue) => issue.path.includes("__proto__"))).toBe(true);
  });

  it("refuses single evaluate when an attribute key is __proto__", async () => {
    const { app } = await makeSdkRouteHarness({ liveRun: true });
    const body = JSON.parse(
      `{"flagKey":"${FLAG_KEY}","targetingKey":"user-1","idType":"user","attributes":{"__proto__":true}}`,
    ) as Record<string, unknown>;

    const res = await app.request(EVALUATE_PATH, sdkRouteInit(CLIENT_KEY, {}, body));
    const error = (await res.json()) as ErrorResponse;

    expect(res.status).toBe(400);
    expect(error.code).toBe("VALIDATION_ERROR");
    if (error.code !== "VALIDATION_ERROR") {
      return;
    }
    expect(error.details.issues.some((issue) => issue.path.includes("__proto__"))).toBe(true);
  });
});
