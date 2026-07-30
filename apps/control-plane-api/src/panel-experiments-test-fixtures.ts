import type { StatsOutput } from "@splitch/contracts";

export interface PanelExperimentIds {
  appId: string;
  environmentId: string;
  experimentId: string;
  latestRunId: string;
  previousRunId: string;
  actorId: string;
  flagId: string;
  orgId: string;
}

export function experimentRow(ids: PanelExperimentIds) {
  return {
    id: ids.experimentId,
    appId: ids.appId,
    environmentId: ids.environmentId,
    key: "checkout-test",
    flagId: ids.flagId,
    name: "Checkout Test",
    description: null,
    hypothesis: null,
    status: "running",
    targetingKeyField: "userId",
    targetingKeyType: "user",
    confidenceLevel: 0.95,
    defaultVariantId: "variant_control",
    metrics: "[]",
    guardrailMetrics: "[]",
    activationMetricId: null,
    conversionWindowMs: 0,
    dimensions: "[]",
    draftAllocation: null,
    draftSalt: null,
    draftTargetingRules: null,
    draftSegmentIds: null,
    liveRunId: ids.latestRunId,
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:00.000Z",
  };
}

export function runRow(ids: PanelExperimentIds, runNumber: 1 | 2) {
  const latest = runNumber === 2;
  return {
    id: latest ? ids.latestRunId : ids.previousRunId,
    appId: ids.appId,
    environmentId: ids.environmentId,
    experimentId: ids.experimentId,
    runNumber,
    status: latest ? "running" : "ended",
    targetingKeyField: "userId",
    targetingKeyType: "user",
    salt: latest ? "salt-2" : "salt-1",
    allocation: JSON.stringify(
      latest ? { control: 70, treatment: 30 } : { control: 50, treatment: 50 },
    ),
    controlVariantId: "variant_control",
    variantSet: JSON.stringify([
      { id: "variant_control", name: "control", value: false },
      { id: "variant_treatment", name: "treatment", value: true },
    ]),
    targetingRules: "[]",
    confidenceLevel: 0.95,
    horizon: "sequential",
    targetN: null,
    sampleSizeLocked: null,
    decisionFamily: "[]",
    guardrailDecisions: "[]",
    configHash: latest ? "sha256:two" : "sha256:one",
    startedAt: latest ? "2026-07-19T00:00:00.000Z" : "2026-07-18T00:00:00.000Z",
    endedAt: latest ? null : "2026-07-18T23:00:00.000Z",
    startReason: latest ? "Increase treatment traffic" : null,
    endReason: latest ? null : "Prepared a larger treatment allocation",
    createdAt: latest ? "2026-07-19T00:00:00.000Z" : "2026-07-18T00:00:00.000Z",
    createdBy: ids.actorId,
  };
}

/** A clean, powered, decision-valid Run. Override one branch per failure case. */
export function statsOutput(overrides: Partial<StatsOutput> = {}): StatsOutput {
  return {
    arm_results: [
      {
        variant: "treatment",
        metric_id: "conversion",
        sample_size_n: 500,
        point_estimate: 0.8,
        relative_lift_pct: 12.5,
        ci_lower: 4.1,
        ci_upper: 21.4,
        p_value: 0.002,
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
      srm_p_value: 0.71,
      srm_is_mismatch: false,
      observed_counts: { control: 502, treatment: 498 },
      expected_counts: { control: 500, treatment: 500 },
      activated_srm_p_value: null,
      activated_srm_mismatch: null,
    },
    guardrail_results: [
      {
        metric_id: "latency",
        variant: "treatment",
        ci_lower: -4,
        threshold: -10,
        is_breached: false,
        in_bh_family: false,
        exploratory: false,
        decision_valid: true,
        breach_reason: null,
      },
    ],
    health: {
      multiple_rate: 0,
      multiple_count: 0,
      activation_rates: null,
      activation_balance_p_value: null,
      activation_balance_mismatch: null,
      exposure_counts: { control: 502, treatment: 498 },
      deduped_counts: { control: 502, treatment: 498 },
      low_n_warning: false,
    },
    ...overrides,
  };
}
