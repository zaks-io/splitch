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
} from "./sdk-route-test-fixtures";

const PATH = "/api/sdk/evaluate-all";

describe("POST /api/sdk/evaluate-all: __proto__ Flag Key", () => {
  it("fails loud when a Flag Key is __proto__ instead of silently omitting it", async () => {
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

    const res = await app.request(PATH, evaluateAllRouteInit(CLIENT_KEY));
    const body = (await res.json()) as ErrorResponse;

    // Loud 500 — never a 200 whose evaluations map quietly lost the Flag.
    expect(res.status).toBe(500);
    expect(body.code).toBe("INTERNAL_SERVER_ERROR");
    expect(JSON.stringify(body)).not.toContain(FLAG_KEY);
    expect(evaluationUsageSink.writes).toEqual([]);
  });
});
