import { describe, expect, it } from "vitest";
import { RecordingPerformanceSpanRecorder } from "./performance-span-test-fixture";
import { CLIENT_KEY, makeSdkRouteHarness, sdkRouteInit } from "./sdk-route-test-fixtures";

describe("POST /api/sdk/evaluate performance spans", () => {
  it("records identity, resolution, and commit without Evaluation data", async () => {
    const spans = new RecordingPerformanceSpanRecorder();
    const { app } = await makeSdkRouteHarness({ spans });

    const response = await app.request("/api/sdk/evaluate", sdkRouteInit(CLIENT_KEY));

    expect(response.status).toBe(200);
    expect(spans.records).toEqual([
      {
        descriptor: { name: "Evaluate identity admission", op: "auth" },
        attributes: {},
      },
      { descriptor: { name: "Evaluate resolution", op: "function" }, attributes: {} },
      { descriptor: { name: "Evaluate commit", op: "http.client" }, attributes: {} },
    ]);
  });
});
