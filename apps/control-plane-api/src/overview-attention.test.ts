import { describe, expect, it } from "vitest";
import { classifyOverviewExperiments } from "./overview-attention";
import { overviewStats } from "./overview-test-fixtures";
import { MULTIPLE_ASSIGNMENT_RATE_THRESHOLD } from "./overview-thresholds";

const sequential = { state: "read", horizon: "sequential", sampleSizeLocked: null } as const;

describe("classifyOverviewExperiments", () => {
  it("flags a Run whose locked decision family reached significance", () => {
    const { needingDecision, failing } = classifyOverviewExperiments([
      {
        id: "exp_significance",
        name: "Significance",
        runId: "run_significance",
        ...sequential,
        stats: overviewStats({ deduped: { control: 4_011, treatment: 3_989 }, significant: true }),
      },
    ]);

    expect(needingDecision).toEqual([
      {
        id: "exp_significance",
        name: "Significance",
        runId: "run_significance",
        reasons: ["significance_reached"],
      },
    ]);
    expect(failing).toEqual([]);
  });

  it("ignores a significant arm that is outside the locked decision family", () => {
    const stats = overviewStats({ deduped: { control: 501, treatment: 499 }, significant: true });
    const [arm] = stats.arm_results;
    if (!arm) throw new Error("fixture is missing an arm result");
    const { needingDecision } = classifyOverviewExperiments([
      {
        id: "exp_exploratory",
        name: "Exploratory",
        runId: "run_exploratory",
        ...sequential,
        stats: { ...stats, arm_results: [{ ...arm, in_bh_family: false }] },
      },
    ]);

    expect(needingDecision).toEqual([]);
  });

  it("reports horizon_reached only for a fixed-horizon Run at its locked sample size", () => {
    const stats = overviewStats({ deduped: { control: 1_200, treatment: 1_150 } });
    const reasonsFor = (horizon: string, sampleSizeLocked: number | null) =>
      classifyOverviewExperiments([
        {
          state: "read",
          id: "exp_h",
          name: "Horizon",
          runId: "run_h",
          horizon,
          sampleSizeLocked,
          stats,
        },
      ]).needingDecision.flatMap((experiment) => experiment.reasons);

    expect(reasonsFor("fixed", 2_350)).toEqual(["horizon_reached"]);
    expect(reasonsFor("fixed", 2_351)).toEqual([]);
    expect(reasonsFor("sequential", 2_350)).toEqual([]);
    expect(reasonsFor("fixed", null)).toEqual([]);
  });

  it("reports every failure a Run is in at once", () => {
    const { failing } = classifyOverviewExperiments([
      {
        id: "exp_broken",
        name: "Broken",
        runId: "run_broken",
        ...sequential,
        stats: overviewStats({
          deduped: { control: 7_100, treatment: 6_400 },
          srm: true,
          guardrail: true,
          multipleRate: 0.031,
        }),
      },
    ]);

    expect(failing[0]?.reasons).toEqual([
      "srm_firing",
      "guardrail_breached",
      "multiple_assignment_quarantine",
    ]);
  });

  it("quarantines at the threshold and not below it", () => {
    const reasonsAt = (multipleRate: number) =>
      classifyOverviewExperiments([
        {
          id: "exp_multiple",
          name: "Multiple",
          runId: "run_multiple",
          ...sequential,
          stats: overviewStats({ deduped: { control: 2_200, treatment: 2_180 }, multipleRate }),
        },
      ]).failing.flatMap((experiment) => experiment.reasons);

    expect(reasonsAt(MULTIPLE_ASSIGNMENT_RATE_THRESHOLD)).toEqual([
      "multiple_assignment_quarantine",
    ]);
    expect(reasonsAt(MULTIPLE_ASSIGNMENT_RATE_THRESHOLD - 0.0001)).toEqual([]);
  });

  it("reports a Run with no Analysis result as no_data, never as clear", () => {
    const { needingDecision, failing, noData } = classifyOverviewExperiments([
      { state: "no_data", id: "exp_fresh", name: "Fresh", runId: "run_fresh" },
    ]);

    expect(needingDecision).toEqual([]);
    expect(failing).toEqual([]);
    expect(noData).toEqual([{ id: "exp_fresh", name: "Fresh", runId: "run_fresh" }]);
  });

  it("lists a Run that is both ready to decide and failing in both sections", () => {
    const { needingDecision, failing } = classifyOverviewExperiments([
      {
        id: "exp_both",
        name: "Both",
        runId: "run_both",
        ...sequential,
        stats: overviewStats({
          deduped: { control: 9_050, treatment: 8_400 },
          significant: true,
          srm: true,
        }),
      },
    ]);

    expect(needingDecision.map((experiment) => experiment.id)).toEqual(["exp_both"]);
    expect(failing.map((experiment) => experiment.id)).toEqual(["exp_both"]);
  });
});
