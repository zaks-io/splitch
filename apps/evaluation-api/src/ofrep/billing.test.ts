import { flagConfigKey } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { flagConfigKV } from "../provider/fixtures";
import {
  APP_ID,
  CLIENT_KEY,
  ENVIRONMENT_ID,
  FLAG_KEY,
  makeSdkRouteHarness,
} from "../sdk-route-test-fixtures";
import { ofrepInit } from "./public-shapes";

describe("OFREP billing follows ADR-0033", () => {
  it("bills a bulk fetch of 10 Flags as 10 Evaluations and records no Exposure", async () => {
    const harness = await makeSdkRouteHarness();
    for (let index = 2; index <= 10; index += 1) {
      const key = `flag-${String(index)}`;
      harness.configKv.put(
        flagConfigKey(APP_ID, ENVIRONMENT_ID, key),
        flagConfigKV({
          id: `flag-id-${String(index)}`,
          key,
          experimentId: null,
          targetingRules: [],
          rollout: null,
        }),
      );
    }

    const response = await harness.app.request("/ofrep/v1/evaluate/flags", ofrepInit(CLIENT_KEY));
    const body = (await response.json()) as { flags: unknown[] };

    expect(response.status).toBe(200);
    expect(body.flags).toHaveLength(10);
    expect(harness.evaluationUsageSink.writes).toEqual([
      expect.objectContaining({
        evaluationCount: 10,
        isBatch: true,
        isCached: false,
        hasExposure: false,
        flagKey: "*",
      }),
    ]);
    expect(harness.exposureSink.writes).toHaveLength(0);
    expect(harness.assignmentStore.putCalls).toEqual([]);
  });

  it("does not bill a matching bulk 304 revalidation", async () => {
    const harness = await makeSdkRouteHarness();
    const first = await harness.app.request("/ofrep/v1/evaluate/flags", ofrepInit(CLIENT_KEY));
    const etag = first.headers.get("etag");
    const again = await harness.app.request(
      "/ofrep/v1/evaluate/flags",
      ofrepInit(CLIENT_KEY, { "if-none-match": etag ?? "" }),
    );

    expect(first.status).toBe(200);
    expect(again.status).toBe(304);
    expect(harness.evaluationUsageSink.writes).toHaveLength(1);
    expect(harness.evaluationUsageSink.writes[0]).toMatchObject({ evaluationCount: 1 });
  });

  it("bills one Exposure-bearing single-Flag evaluation as one Evaluation", async () => {
    const harness = await makeSdkRouteHarness({
      liveRun: true,
      runOverrides: { allocation: { control: 0, treatment: 100 }, targetingRules: [] },
    });

    const response = await harness.app.request(
      `/ofrep/v1/evaluate/flags/${FLAG_KEY}`,
      ofrepInit(CLIENT_KEY),
    );

    expect(response.status).toBe(200);
    expect(harness.evaluationUsageSink.writes).toEqual([
      expect.objectContaining({
        evaluationCount: 1,
        isBatch: false,
        hasExposure: true,
        flagKey: FLAG_KEY,
      }),
    ]);
    expect(harness.exposureSink.writes).toHaveLength(1);
  });
});
