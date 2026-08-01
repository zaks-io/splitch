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
 * These two suites are NOT wired together, and the join is not claimed to be
 * automatic: `apps/control-plane-api/test/variant-rename-run-freeze.test.ts`
 * asserts the invariant ("every arm the frozen allocation can select still names
 * a Variant in the published catalog") against KV blobs it publishes for real,
 * and this file hand-builds the one shape that invariant forbids and executes
 * what it costs. They meet at a literal — the arm name `treatment` present in
 * `run.allocation` and absent from the catalog — not at a shared fixture.
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
    expect(await res.json()).toEqual({ variant: false, variantName: "control" });
  });
});
