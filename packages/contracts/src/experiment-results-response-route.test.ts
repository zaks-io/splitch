import { describe, expect, it } from "vitest";
import { getRoute } from "./route-registry";
import { StatsOutputSchema } from "./stats-result-contract";

/**
 * The /results routes are the seam every generated client infers from. The
 * Control Plane result producer (plan 0.15) leads with readiness / blockedBy /
 * reasons; detailed keeps Analysis stats byte-unchanged.
 */

const statsOutput = StatsOutputSchema.parse({
  arm_results: [
    {
      variant: "treatment",
      metric_id: "metric_1",
      sample_size_n: 250,
      point_estimate: 0.14,
      relative_lift_pct: 12.5,
      ci_lower: 1.2,
      ci_upper: 23.8,
      p_value: 0.03,
      is_significant: true,
      in_bh_family: true,
      exploratory: false,
      decision_valid: true,
      status: "ready",
      variance_techniques: {
        winsorized: false,
        winsorize_pct: null,
        winsorize_cap: null,
        cuped_applied: false,
        cuped_method: null,
        cuped_attribute: null,
        cuped_attribute_source: null,
        cuped_coverage_pct: null,
        delta_method: false,
      },
    },
  ],
  srm: {
    srm_p_value: 0.51,
    srm_is_mismatch: false,
    observed_counts: { control: 250, treatment: 250 },
    expected_counts: { control: 250, treatment: 250 },
    activated_srm_p_value: null,
    activated_srm_mismatch: null,
  },
  guardrail_results: [],
  health: {
    multiple_rate: 0,
    multiple_count: 0,
    activation_rates: null,
    activation_balance_p_value: null,
    activation_balance_mismatch: null,
    exposure_counts: { control: 250, treatment: 250 },
    deduped_counts: { control: 250, treatment: 250 },
    low_n_warning: false,
  },
});

describe("declared /results response contract", () => {
  const gate = {
    shipAllowed: true,
    blockedBy: [] as const,
    checks: [] as const,
    enforcedBy: "control-plane-api" as const,
  };
  const control = {
    state: "frozen" as const,
    variantId: "variant_control",
    variant: "control",
  };
  const envelope = {
    view: "detailed" as const,
    state: "ready" as const,
    readiness: { statistical: true, concludeExecutable: true },
    blockedBy: [] as string[],
    reasons: [] as string[],
    recommendationUnavailable: "no_pre_registration" as const,
    gate,
    run_id: "run_1",
    run_number: 1,
    run_status: "running" as const,
    control_variant: "control",
    control,
    data_watermark: "2026-07-22T12:00:00.000Z",
    result_token: `sha256:${"a".repeat(64)}`,
    stats: statsOutput,
  };

  function declaredResponse(operationId: string) {
    const route = getRoute(operationId);
    if (!route) throw new Error(`no registered route for ${operationId}`);
    return route.output;
  }

  it.each(["experiment_results_get", "experiment_results_post"] as const)(
    "%s declares the Control Plane producer response, not a bare StatsOutput",
    (operationId) => {
      const response = declaredResponse(operationId);
      expect(response.safeParse(envelope).success).toBe(true);
      expect(response.safeParse(statsOutput).success).toBe(false);
    },
  );

  it.each(["run_id", "control_variant", "state", "readiness", "blockedBy", "reasons"] as const)(
    "%s is required on the envelope",
    (field) => {
      const { [field]: _dropped, ...withoutField } = envelope;
      expect(declaredResponse("experiment_results_get").safeParse(withoutField).success).toBe(
        false,
      );
    },
  );

  it("accepts decision evidence only as a complete pair", () => {
    const { data_watermark: _watermark, ...withoutWatermark } = envelope;
    const { result_token: _token, ...withoutToken } = envelope;
    expect(declaredResponse("experiment_results_get").safeParse(withoutWatermark).success).toBe(
      false,
    );
    expect(declaredResponse("experiment_results_get").safeParse(withoutToken).success).toBe(false);
    expect(
      declaredResponse("experiment_results_get").safeParse({
        ...envelope,
        data_watermark: undefined,
        result_token: undefined,
      }).success,
    ).toBe(true);
  });

  it("rejects camel-case decision evidence fields", () => {
    const { data_watermark: dataWatermark, result_token: resultToken, ...rest } = envelope;
    expect(
      declaredResponse("experiment_results_get").safeParse({
        ...rest,
        dataWatermark,
        resultToken,
      }).success,
    ).toBe(false);
  });

  it("accepts a concise ready member without stats", () => {
    const { stats: _stats, ...conciseBase } = envelope;
    expect(
      declaredResponse("experiment_results_get").safeParse({
        ...conciseBase,
        view: "concise",
      }).success,
    ).toBe(true);
  });

  it("accepts a no_data envelope that names the missing input", () => {
    expect(
      declaredResponse("experiment_results_get").safeParse({
        view: "detailed",
        state: "no_data",
        readiness: { statistical: false, concludeExecutable: false },
        blockedBy: [],
        reasons: ["No Metric Events have been observed for this Run yet."],
        run_id: "run_1",
        run_number: 1,
        run_status: "running",
        control_variant: "control",
        control,
        missing: "metric_events",
      }).success,
    ).toBe(true);
  });

  it("accepts a no_run envelope that names Start, without inventing a Run id", () => {
    expect(
      declaredResponse("experiment_results_get").safeParse({
        view: "detailed",
        state: "no_run",
        readiness: { statistical: false, concludeExecutable: false },
        blockedBy: [],
        reasons: ["No Run has been Started for this Experiment. Call experiments_start."],
        recommended_action: "START_A_RUN",
      }).success,
    ).toBe(true);
    expect(
      declaredResponse("experiment_results_get").safeParse({
        view: "detailed",
        state: "no_run",
        readiness: { statistical: false, concludeExecutable: false },
        blockedBy: [],
        reasons: [],
        recommended_action: "START_A_RUN",
        run_id: "run_placeholder",
      }).success,
    ).toBe(false);
  });

  it("rejects a no_run envelope that omits recommended_action", () => {
    expect(
      declaredResponse("experiment_results_get").safeParse({
        view: "detailed",
        state: "no_run",
        readiness: { statistical: false, concludeExecutable: false },
        blockedBy: [],
        reasons: [],
      }).success,
    ).toBe(false);
  });
});
