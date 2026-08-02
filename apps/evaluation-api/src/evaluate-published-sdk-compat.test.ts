import { describe, expect, it } from "vitest";
import { CLIENT_KEY, makeSdkRouteHarness, sdkRouteInit } from "./sdk-route-test-fixtures";

const PATH = "/api/sdk/evaluate";

/**
 * The exact key set the response schema bundled into @splitch/sdk@0.2.0 accepts.
 * Every SDK inlines a build-time snapshot of the contract
 * (packages/sdk/src/generated/contract-surface.js), so a client in the wild
 * parses with the schema of the day it shipped, not today's -- and that snapshot
 * is `.strict()`, so any key outside this set makes it throw.
 *
 * The SDK swallows that throw into `status: null` -> `reason: "ERROR"` -> the
 * caller's default. The Worker has already committed the Exposure by then, so an
 * added body key does not degrade the response, it silently corrupts every
 * running Experiment: recorded as the assigned arm, served as the default.
 *
 * Hard-coded rather than derived from today's contract, precisely so that
 * changing the contract cannot quietly change what this asserts. New evaluation
 * metadata rides a response header until no supported SDK parses strictly.
 */
const PUBLISHED_SDK_BODY_KEYS = ["variant"];

describe("evaluate wire compatibility with published SDKs", () => {
  it.each([
    ["a live Run", { liveRun: true }],
    ["a disabled Flag", { flagOverrides: { enabled: false } }],
    ["no controlling Experiment", { flagOverrides: { experimentId: null } }],
  ] as const)("returns a body @splitch/sdk@0.2.0 still parses for %s", async (_case, options) => {
    const { app } = await makeSdkRouteHarness({
      runOverrides: { allocation: { control: 0, treatment: 100 }, targetingRules: [] },
      ...options,
    });

    const res = await app.request(PATH, sdkRouteInit(CLIENT_KEY));

    expect(res.status).toBe(200);
    expect(Object.keys((await res.json()) as object)).toEqual(PUBLISHED_SDK_BODY_KEYS);
  });

  it("carries the arm label out of band, where an old strict parser cannot see it", async () => {
    const { app } = await makeSdkRouteHarness({
      liveRun: true,
      runOverrides: { allocation: { control: 0, treatment: 100 }, targetingRules: [] },
    });

    const res = await app.request(PATH, sdkRouteInit(CLIENT_KEY));
    const body = (await res.json()) as object;

    expect(res.headers.get("x-variant-name")).toBe("treatment");
    expect(body).not.toHaveProperty("variantName");
    expect(Object.keys(body)).toEqual(PUBLISHED_SDK_BODY_KEYS);
  });
});
