import { describe, expect, it, vi } from "vitest";
import { StaticSaltStore } from "./assignment/assignment-store-test-fixtures";
import { RecordingPerformanceSpanRecorder } from "./performance-span-test-fixture";
import { CLIENT_KEY, makeSdkRouteHarness, sdkRouteInit } from "./sdk-route-test-fixtures";

describe("Verify identity revalidation span", () => {
  it.each([false, true])("wraps the trailing read, including reset refusal %s", async (reset) => {
    const spans = new RecordingPerformanceSpanRecorder();
    const saltStore = new StaticSaltStore();
    const current = vi.spyOn(saltStore, "currentKeyVersion").mockImplementation(async () => {
      if (spans.records.at(-1)?.descriptor.name === "Verify identity revalidation") {
        return reset ? "v2" : "v1";
      }
      return "v1";
    });
    const { app, exposureSink } = await makeSdkRouteHarness({ spans, saltStore });

    const response = await app.request("/api/sdk/verify", sdkRouteInit(CLIENT_KEY));

    expect(response.status).toBe(reset ? 503 : 200);
    expect(spans.records.map(({ descriptor }) => descriptor)).toEqual([
      { name: "Verify flag configuration", op: "function" },
      { name: "Verify identity admission", op: "auth" },
      { name: "Verify identity revalidation", op: "auth" },
    ]);
    expect(spans.records.every(({ attributes }) => Object.keys(attributes).length === 0)).toBe(
      true,
    );
    expect(current).toHaveBeenCalled();
    expect(exposureSink.writes).toEqual([]);
  });
});
