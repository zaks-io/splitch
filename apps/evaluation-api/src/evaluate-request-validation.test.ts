import type { ErrorResponse } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { CLIENT_KEY, makeSdkRouteHarness, sdkRouteInit } from "./sdk-route-test-fixtures";

const PATH = "/api/sdk/evaluate";

function liveRunHarness() {
  return makeSdkRouteHarness({ liveRun: true });
}

describe("POST /api/sdk/evaluate: request body validation", () => {
  it.each([
    ["empty appId", { appId: "" }, "appId"],
    ["empty flagKey", { flagKey: "" }, "flagKey"],
  ] as const)(
    "returns VALIDATION_ERROR for %s before handler data access",
    async (_case, body, field) => {
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
    },
  );
});
