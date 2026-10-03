import { describe, expect, it } from "vitest";
import { type PreRegistrationIssue, resolvePreRegistration } from "./run-preregistration-resolve";
import { PreRegistrationSchema } from "./run-preregistration";

const RUN_METRICS = new Set(["metric_goal", "metric_guard"]);

const validIntent = {
  hypothesis: "Treatment raises signup rate by at least 2pp",
  primaryMetricId: "metric_goal",
  metrics: [
    {
      metricId: "metric_goal",
      desirability: "higher_is_better" as const,
      mdeAbsolute: 0.02,
      rope: { lower: -0.005, upper: 0.005, scale: "absolute" as const },
    },
    {
      metricId: "metric_guard",
      desirability: "lower_is_better" as const,
    },
  ],
  shipRule: {
    requiredMargin: 0.02,
    marginScale: "absolute" as const,
    conflictResolution: "primary_wins" as const,
  },
};

function codes(issues: PreRegistrationIssue[]) {
  return issues.map((issue) => issue.code);
}

describe("resolvePreRegistration", () => {
  it("freezes a valid intent into snake_case PreRegistration", () => {
    const result = resolvePreRegistration(validIntent, RUN_METRICS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(PreRegistrationSchema.parse(result.value)).toEqual({
      hypothesis: validIntent.hypothesis,
      primary_metric_id: "metric_goal",
      metrics: [
        {
          metric_id: "metric_goal",
          desirability: "higher_is_better",
          mde_absolute: 0.02,
          rope: { lower: -0.005, upper: 0.005, scale: "absolute" },
        },
        { metric_id: "metric_guard", desirability: "lower_is_better" },
      ],
      ship_rule: {
        required_margin: 0.02,
        margin_scale: "absolute",
        conflict_resolution: "primary_wins",
      },
      futility: "off",
    });
  });

  it("refuses an unknown primary Metric with PREREG_UNKNOWN_PRIMARY_METRIC", () => {
    const result = resolvePreRegistration(
      { ...validIntent, primaryMetricId: "metric_missing" },
      RUN_METRICS,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(codes(result.issues)).toContain("PREREG_UNKNOWN_PRIMARY_METRIC");
  });

  it("refuses ROPE lower >= upper with PREREG_ROPE_BOUNDS_INVALID", () => {
    const result = resolvePreRegistration(
      {
        ...validIntent,
        metrics: [
          {
            metricId: "metric_goal",
            desirability: "higher_is_better",
            rope: { lower: 0.1, upper: 0.1, scale: "absolute" },
          },
        ],
      },
      RUN_METRICS,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(codes(result.issues)).toContain("PREREG_ROPE_BOUNDS_INVALID");
  });

  it("refuses a relative ROPE with PREREG_ROPE_RELATIVE_UNSUPPORTED", () => {
    const result = resolvePreRegistration(
      {
        ...validIntent,
        metrics: [
          {
            metricId: "metric_goal",
            desirability: "higher_is_better",
            rope: { lower: -0.05, upper: 0.05, scale: "relative" },
          },
        ],
      },
      RUN_METRICS,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(codes(result.issues)).toContain("PREREG_ROPE_RELATIVE_UNSUPPORTED");
  });

  it("refuses an MDE without desirability with PREREG_DESIRABILITY_REQUIRED", () => {
    const result = resolvePreRegistration(
      {
        ...validIntent,
        metrics: [{ metricId: "metric_goal", mdeAbsolute: 0.02 }],
      },
      RUN_METRICS,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(codes(result.issues)).toContain("PREREG_DESIRABILITY_REQUIRED");
  });

  it("refuses a Metric that is not on the Run with PREREG_UNKNOWN_METRIC", () => {
    const result = resolvePreRegistration(
      {
        ...validIntent,
        metrics: [
          ...validIntent.metrics,
          { metricId: "metric_other", desirability: "higher_is_better" },
        ],
      },
      RUN_METRICS,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(codes(result.issues)).toContain("PREREG_UNKNOWN_METRIC");
  });

  it("refuses an empty hypothesis with PREREG_HYPOTHESIS_REQUIRED", () => {
    const result = resolvePreRegistration({ ...validIntent, hypothesis: "" }, RUN_METRICS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(codes(result.issues)).toContain("PREREG_HYPOTHESIS_REQUIRED");
  });

  it("refuses a non-positive ship margin with PREREG_SHIP_RULE_INVALID", () => {
    const result = resolvePreRegistration(
      {
        ...validIntent,
        shipRule: { ...validIntent.shipRule, requiredMargin: 0 },
      },
      RUN_METRICS,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(codes(result.issues)).toContain("PREREG_SHIP_RULE_INVALID");
  });
});

describe("resolvePreRegistration futility mode", () => {
  it("freezes omitted futility as off and preserves mde_exclusion when set", () => {
    const off = resolvePreRegistration(validIntent, RUN_METRICS);
    expect(off.ok).toBe(true);
    if (!off.ok) return;
    expect(off.value.futility).toBe("off");

    const on = resolvePreRegistration({ ...validIntent, futility: "mde_exclusion" }, RUN_METRICS);
    expect(on.ok).toBe(true);
    if (!on.ok) return;
    expect(on.value.futility).toBe("mde_exclusion");
  });

  it("parses a legacy freeze without futility as off", () => {
    const legacy = {
      hypothesis: "legacy",
      primary_metric_id: "metric_goal",
      metrics: [{ metric_id: "metric_goal", desirability: "higher_is_better" }],
      ship_rule: {
        required_margin: 0.02,
        margin_scale: "absolute",
        conflict_resolution: "primary_wins",
      },
    };
    expect(PreRegistrationSchema.parse(legacy).futility).toBe("off");
  });

  it("refuses mde_exclusion without an absolute primary MDE", () => {
    const result = resolvePreRegistration(
      {
        ...validIntent,
        futility: "mde_exclusion",
        metrics: [
          { metricId: "metric_goal", desirability: "higher_is_better" },
          { metricId: "metric_guard", desirability: "lower_is_better" },
        ],
      },
      RUN_METRICS,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(codes(result.issues)).toContain("PREREG_FUTILITY_REQUIRES_ABSOLUTE_MDE");
  });

  it("refuses mde_exclusion when the primary has only a relative MDE", () => {
    const result = resolvePreRegistration(
      {
        ...validIntent,
        futility: "mde_exclusion",
        metrics: [
          {
            metricId: "metric_goal",
            desirability: "higher_is_better",
            mdeRelative: 0.1,
          },
          { metricId: "metric_guard", desirability: "lower_is_better" },
        ],
      },
      RUN_METRICS,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(codes(result.issues)).toContain("PREREG_FUTILITY_REQUIRES_ABSOLUTE_MDE");
  });
});
