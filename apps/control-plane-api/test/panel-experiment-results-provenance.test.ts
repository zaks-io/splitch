import { beforeAll, describe, expect, it } from "vitest";
import type { PanelExperimentResultsOutput } from "@splitch/control-plane-sdk/panel-experiments";
import {
  createExperimentDraft,
  experimentFixture,
  type ExperimentRunHarness,
  makeExperimentRunHarness,
  startExperiment,
  type StartResponse,
} from "../src/experiment-run-test-fixture.js";
import { analysisEnvelope, statsOutput } from "../src/panel-experiments-test-fixtures.js";
import {
  analysisReturning,
  callPanelResults,
  type PanelResultsTarget,
} from "./panel-results-request.js";
import { makePoolBindings as makeLocalBindings } from "./pool-bindings.js";

/**
 * The Control arm the Results tab reports is provenance, against real D1.
 *
 * These assertions only mean something end to end: the frozen
 * `runs.control_variant_id` has to survive the repository read, the route, and
 * the Panel contract. A unit test on the resolver alone would still pass if this
 * read went back to the Experiment's current default Variant.
 */

let ctx: ExperimentRunHarness;
let target: PanelResultsTarget;
let treatmentVariantId: string;
let controlVariantId: string;

beforeAll(async () => {
  ctx = await makeExperimentRunHarness(makeLocalBindings);
  const fx = await experimentFixture(ctx);
  const experiment = await createExperimentDraft(ctx, fx, {
    key: "results-provenance-exp",
    allocation: { control: 50, treatment: 50 },
    salt: "results-provenance-salt",
    segmentIds: [fx.segmentId],
  });
  const start = await startExperiment(ctx, fx, experiment.id);
  if (start.status !== 200) throw new Error(`start failed: ${start.status} ${await start.text()}`);
  const started = (await start.json()) as StartResponse;
  controlVariantId = fx.flag.defaultVariantId;
  const treatment = fx.flag.variants.find((variant) => variant.id !== controlVariantId);
  if (!treatment) throw new Error("fixture Flag has no second Variant to promote");
  treatmentVariantId = treatment.id;
  target = {
    appId: fx.appId,
    environmentId: fx.environmentId,
    experimentId: experiment.id,
    runId: started.run.id,
  };
});

async function readResults(): Promise<PanelExperimentResultsOutput> {
  const response = await callPanelResults(
    analysisReturning(Response.json(analysisEnvelope(target.runId, statsOutput()))),
    target,
  );
  if (response.status !== 200) {
    throw new Error(`results read failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as PanelExperimentResultsOutput;
}

describe("Results Control provenance", () => {
  it("reports the Control the Run froze", async () => {
    const results = await readResults();

    expect(results.control).toEqual({
      state: "frozen",
      variantId: controlVariantId,
      variant: "control",
    });
  });

  // The point of the frozen column. Before it existed, this edit relabelled a
  // historical Run's arms and inverted every lift on the page.
  it("does not move when the Experiment's default Variant is changed after Start", async () => {
    await ctx.h.bindings.d1
      .prepare("UPDATE experiments SET default_variant_id = ? WHERE id = ?")
      .bind(treatmentVariantId, target.experimentId)
      .run();

    const results = await readResults();

    expect(results.control.variantId).toBe(controlVariantId);
    expect(results.control).toMatchObject({ state: "frozen", variant: "control" });
    expect(results.gate.blockedBy).not.toContain("control_identity");
  });

  // Written the way the SPL-184 backfill writes: raw SQL, no membership check
  // against the Run's own frozen Variant set.
  it("names a backfilled Control that the Run never froze, and blocks on it", async () => {
    await ctx.h.bindings.d1
      .prepare("UPDATE runs SET control_variant_id = ? WHERE id = ?")
      .bind("variant_from_a_later_edit", target.runId)
      .run();

    const results = await readResults();

    expect(results.control).toMatchObject({
      state: "unresolvable",
      variantId: "variant_from_a_later_edit",
      reason: "absent_from_frozen_variant_set",
    });
    expect(results.gate.shipAllowed).toBe(false);
    expect(results.gate.blockedBy).toContain("control_identity");
    const check = results.gate.checks.find((entry) => entry.id === "control_identity");
    expect(check?.detail).toContain("variant_from_a_later_edit");
    // Still served: the refusal is on the decision, never on the numbers.
    expect(results.stats.arm_results.length).toBeGreaterThan(0);
  });
});
