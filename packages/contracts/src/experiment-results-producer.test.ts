import { describe, expect, it } from "vitest";
import { reachedDuration, stats } from "./experiment-decision-gate-test-fixtures";
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
    expect(Object.keys(parsed).slice(0, 5)).toEqual([
      "view",
      "state",
      "readiness",
      "blockedBy",
      "reasons",
    ]);
    expect(parsed.readiness).toEqual({ statistical: true, concludeExecutable: true });
    expect(parsed.blockedBy).toEqual([]);
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
    });
    expect(parsed).not.toHaveProperty("stats");
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
