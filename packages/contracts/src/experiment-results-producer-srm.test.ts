import { describe, expect, it } from "vitest";
import { stats } from "./experiment-decision-gate-test-fixtures";
import { produceExperimentResults } from "./experiment-results-producer";
import { readyAnalysis, run } from "./experiment-results-producer-test-fixtures";
import { ExperimentResultsResponseSchema } from "./experiment-results-response";

describe("produceExperimentResults persisted SRM alarms", () => {
  it("keeps Analysis stats byte-identical when durable alarms OR into the gate", () => {
    const analysis = readyAnalysis({
      stats: stats({
        srm: {
          ...stats().srm,
          srm_is_mismatch: false,
          srm_p_value: 0.001234,
        },
      }),
    });
    const produced = produceExperimentResults({
      view: "detailed",
      analysis,
      run,
      canConclude: true,
      persistedSrmAlarms: [
        {
          srmKind: "exposure",
          firstCrossedAt: "2026-07-02T00:00:00.000Z",
          pValue: 0.000945,
        },
      ],
    });
    expect(produced.state).toBe("ready");
    if (produced.state !== "ready" || produced.view !== "detailed") {
      throw new Error("expected detailed ready");
    }
    expect(produced.stats).toBe(analysis.stats);
    expect(produced.stats.srm.srm_is_mismatch).toBe(false);
    expect(produced.persisted_srm_alarms).toHaveLength(1);
    expect(produced.gate.blockedBy).toContain("exposure_srm");
    expect(produced.readiness.concludeExecutable).toBe(false);
  });
});

describe("produceExperimentResults srm_root_cause", () => {
  it("attaches srm_root_cause only when the enrich seam supplies a classification", () => {
    const rootCause = {
      branch: "triggered_only" as const,
      explanation: "Activated-population SRM fires while Exposure SRM does not.",
      nextCheck: "experiment_results_get",
    };
    const analysis = readyAnalysis();
    const withCause = produceExperimentResults({
      view: "detailed",
      analysis,
      run,
      canConclude: true,
      srmRootCause: rootCause,
    });
    const withoutCause = produceExperimentResults({
      view: "detailed",
      analysis,
      run,
      canConclude: true,
    });
    expect(ExperimentResultsResponseSchema.parse(withCause)).toMatchObject({
      srm_root_cause: rootCause,
    });
    expect(withoutCause).not.toHaveProperty("srm_root_cause");
    // Diagnostics must not rewrite the Analysis stats object the token binds.
    if (withCause.state !== "ready" || withCause.view !== "detailed") {
      throw new Error("expected detailed ready");
    }
    expect(withCause.stats).toBe(analysis.stats);
  });
});
