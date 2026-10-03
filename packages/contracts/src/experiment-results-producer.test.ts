import { describe, expect, it } from "vitest";
import { armResult, reachedDuration, stats } from "./experiment-decision-gate-test-fixtures";
import { produceExperimentResults } from "./experiment-results-producer";
import { ExperimentResultsResponseSchema } from "./experiment-results-response";
import type { AnalysisResultsEnvelope } from "./stats-result-contract";

const control = {
  state: "frozen" as const,
  variantId: "variant_control",
  variant: "control",
};

const run = {
  runNumber: 2,
  runStatus: "running" as const,
  control,
  duration: reachedDuration(),
};

function readyAnalysis(
  overrides: Partial<Extract<AnalysisResultsEnvelope, { state: "ready" }>> = {},
): Extract<AnalysisResultsEnvelope, { state: "ready" }> {
  return {
    state: "ready",
    run_id: "run_1",
    control_variant: "control",
    data_watermark: "2026-07-08T00:00:00.000Z",
    result_token: `sha256:${"a".repeat(64)}`,
    stats: stats(),
    ...overrides,
  };
}

describe("produceExperimentResults", () => {
  it("puts readiness, blockedBy, and reasons before detailed stats", () => {
    const produced = produceExperimentResults({
      view: "detailed",
      analysis: readyAnalysis(),
      run,
      canConclude: true,
    });
    const parsed = ExperimentResultsResponseSchema.parse(produced);
    expect(parsed.state).toBe("ready");
    if (parsed.state !== "ready" || parsed.view !== "detailed")
      throw new Error("expected detailed");
    expect(Object.keys(parsed).slice(0, 6)).toEqual([
      "view",
      "state",
      "readiness",
      "blockedBy",
      "reasons",
      "recommendationUnavailable",
    ]);
    expect(parsed.readiness).toEqual({ statistical: true, concludeExecutable: true });
    expect(parsed.blockedBy).toEqual([]);
    expect(parsed.recommendationUnavailable).toBe("no_pre_registration");
    expect(parsed.stats).toEqual(readyAnalysis().stats);
  });

  it("keeps detailed stats byte-unchanged from the Analysis envelope", () => {
    const analysis = readyAnalysis();
    const produced = produceExperimentResults({
      view: "detailed",
      analysis,
      run,
      canConclude: true,
    });
    if (produced.state !== "ready" || produced.view !== "detailed") {
      throw new Error("expected detailed ready");
    }
    expect(produced.stats).toBe(analysis.stats);
  });

  it("omits stats on concise while keeping operational handles", () => {
    const produced = produceExperimentResults({
      view: "concise",
      analysis: readyAnalysis(),
      run,
      canConclude: true,
    });
    const parsed = ExperimentResultsResponseSchema.parse(produced);
    expect(parsed).toMatchObject({
      view: "concise",
      state: "ready",
      run_id: "run_1",
      result_token: expect.stringMatching(/^sha256:/),
      data_watermark: "2026-07-08T00:00:00.000Z",
      recommendationUnavailable: "no_pre_registration",
    });
    expect(parsed).not.toHaveProperty("stats");
  });

  it("attaches stats on concise only when includeExploratory is set", () => {
    const analysis = readyAnalysis();
    const produced = produceExperimentResults({
      view: "concise",
      analysis,
      run,
      canConclude: true,
      includeExploratory: true,
    });
    expect(ExperimentResultsResponseSchema.parse(produced)).toMatchObject({
      view: "concise",
      state: "ready",
    });
    if (produced.state !== "ready" || produced.view !== "concise") {
      throw new Error("expected concise ready");
    }
    expect(produced.stats).toBe(analysis.stats);
  });

  it("separates statistical readiness from concludeExecutable lifecycle and permission", () => {
    const produced = produceExperimentResults({
      view: "detailed",
      analysis: readyAnalysis(),
      run: { ...run, runStatus: "ended" },
      canConclude: false,
    });
    expect(produced.readiness).toEqual({ statistical: true, concludeExecutable: false });
    expect(produced.reasons).toEqual(
      expect.arrayContaining([
        expect.stringContaining("running Run"),
        expect.stringContaining("owner or admin"),
      ]),
    );
  });

  it("blocks statistical readiness when the gate fails an evidence check", () => {
    const produced = produceExperimentResults({
      view: "detailed",
      analysis: readyAnalysis({
        stats: stats({
          health: {
            ...stats().health,
            low_n_warning: true,
          },
        }),
      }),
      run,
      canConclude: true,
    });
    expect(produced.readiness.statistical).toBe(false);
    expect(produced.blockedBy).toContain("underpowered");
    expect(produced.readiness.concludeExecutable).toBe(false);
  });

  it("defines an explicit no_run member instead of an error or null", () => {
    const produced = produceExperimentResults({
      view: "concise",
      analysis: { state: "no_run", recommended_action: "START_A_RUN" },
      run: null,
      canConclude: false,
    });
    expect(ExperimentResultsResponseSchema.parse(produced)).toEqual({
      view: "concise",
      state: "no_run",
      readiness: { statistical: false, concludeExecutable: false },
      blockedBy: [],
      reasons: ["No Run has been Started for this Experiment. Call experiments_start."],
      recommended_action: "START_A_RUN",
    });
  });

  it("defines an explicit no_data member naming the missing input", () => {
    const produced = produceExperimentResults({
      view: "detailed",
      analysis: {
        state: "no_data",
        run_id: "run_1",
        control_variant: "control",
        missing: "exposures",
      },
      run,
      canConclude: true,
    });
    expect(produced).toMatchObject({
      state: "no_data",
      missing: "exposures",
      readiness: { statistical: false, concludeExecutable: false },
      run_id: "run_1",
      control: control,
    });
    expect(produced).not.toHaveProperty("stats");
  });
});

describe("produceExperimentResults ship recommendation", () => {
  it("surfaces do_not_ship for a lower_is_better primary with a positive lift", () => {
    const produced = produceExperimentResults({
      view: "detailed",
      analysis: readyAnalysis({
        run_commitments: {
          analysis_version_source: "frozen",
          analysis_version: "analysis-v1",
          target_n: 5000,
          target_n_source: "default",
          planned_duration_days: 7,
          planned_duration_override_reason: null,
          pre_registration: {
            hypothesis: "Treatment lowers latency",
            primary_metric_id: "checkout-conversion",
            metrics: [
              {
                metric_id: "checkout-conversion",
                desirability: "lower_is_better",
              },
            ],
            ship_rule: {
              required_margin: 0.02,
              margin_scale: "absolute",
              conflict_resolution: "primary_wins",
            },
            futility: "off",
          },
        },
        stats: stats({
          arm_results: [
            armResult({
              absolute_ci_lower: 0.02,
              absolute_ci_upper: 0.06,
              ci_lower: 4,
              ci_upper: 12,
              relative_lift_pct: 8,
            }),
          ],
        }),
      }),
      run,
      canConclude: true,
    });
    expect(ExperimentResultsResponseSchema.parse(produced)).toMatchObject({
      recommendation: {
        verdict: "do_not_ship",
        because: expect.stringMatching(/positive lift/),
      },
    });
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

describe("produceExperimentResults cohort_effect", () => {
  const cohortEffect = {
    state: "unavailable" as const,
    reason: "insufficient_entities" as const,
  };

  it("attaches cohort_effect on detailed Results only", () => {
    const analysis = readyAnalysis();
    const detailed = produceExperimentResults({
      view: "detailed",
      analysis,
      run,
      canConclude: true,
      cohortEffect,
    });
    const concise = produceExperimentResults({
      view: "concise",
      analysis,
      run,
      canConclude: true,
      cohortEffect,
    });
    expect(ExperimentResultsResponseSchema.parse(detailed)).toMatchObject({
      cohort_effect: cohortEffect,
    });
    expect(concise).not.toHaveProperty("cohort_effect");
    if (detailed.state !== "ready" || detailed.view !== "detailed") {
      throw new Error("expected detailed ready");
    }
    expect(detailed.stats).toBe(analysis.stats);
  });

  it("omits cohort_effect when Analysis did not emit it", () => {
    const produced = produceExperimentResults({
      view: "detailed",
      analysis: readyAnalysis(),
      run,
      canConclude: true,
    });
    expect(produced).not.toHaveProperty("cohort_effect");
  });
});
