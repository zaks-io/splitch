import type { ErrorResponse } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { CLIENT_KEY, makeSdkRouteHarness, sdkRouteInit } from "./sdk-route-test-fixtures";

/**
 * SPL-267 blast radius, executed.
 *
 * A live Run's `allocation` and `variantSet` are frozen at Start and keyed by
 * Variant NAME. The KV Flag snapshot carries the CURRENT App-level catalog. When
 * the catalog is renamed under a live Run, the two disagree, and `responseBody`
 * resolves the assigned name against the catalog, not against the Run's own
 * frozen `variantSet`.
 *
 * The blobs below are not invented. They are the shapes the control-plane write
 * path actually produced in
 * `apps/control-plane-api/test/variant-rename-run-freeze.test.ts`
 * ("records the KV snapshot a post-rename evaluate would read") after a rename
 * of `treatment` -> `treatment_pwned` while `run_live` was live:
 *
 *   flag.variants:              [control, treatment_pwned, canary]
 *   flag.availableVariantNames: [control, treatment_pwned]
 *   run.allocation:             { control: 50, treatment: 50 }
 *   run.variantSet:             [control, treatment]
 */

const PATH = "/api/sdk/evaluate";

const RENAMED_CATALOG = {
  variants: [
    { id: "v-control", name: "control", value: false },
    { id: "v-treatment", name: "treatment_pwned", value: true },
  ],
  availableVariantNames: ["control", "treatment_pwned"],
  // The Run's own targeting is what drives assignment below; the Flag's
  // rule list would short-circuit it.
  targetingRules: [],
};

describe("a Variant renamed under a live Run", () => {
  it("500s the traffic the frozen allocation sends to the renamed arm", async () => {
    const { app, exposureSink } = await makeSdkRouteHarness({
      liveRun: true,
      flagOverrides: RENAMED_CATALOG,
      // 100% of the Run's traffic lands on the arm whose name the rename removed.
      runOverrides: { allocation: { control: 0, treatment: 100 }, targetingRules: [] },
    });

    const res = await app.request(PATH, sdkRouteInit(CLIENT_KEY));
    const body = (await res.json()) as ErrorResponse;

    expect(res.status).toBe(500);
    expect(body.code).toBe("INTERNAL_SERVER_ERROR");
    // The caller gets the generic wire message; the Variant name stays server-side.
    expect(body.message).toBe("evaluation failed");
    // No Exposure: the request produced no served value, so nothing is counted.
    expect(exposureSink.writes).toEqual([]);
  });

  it("still serves the arm whose name the rename left alone", async () => {
    const { app } = await makeSdkRouteHarness({
      liveRun: true,
      flagOverrides: RENAMED_CATALOG,
      runOverrides: { allocation: { control: 100, treatment: 0 }, targetingRules: [] },
    });

    const res = await app.request(PATH, sdkRouteInit(CLIENT_KEY));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ variant: false });
  });
});
