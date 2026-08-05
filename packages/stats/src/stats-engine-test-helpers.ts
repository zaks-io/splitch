import type { DedupeExposureRow, PerEntityMetricRow, StatsInput } from "@splitch/contracts";

export const ENGINE_RUN_ID = "run_stats_engine";
const ENGINE_TS = "2026-07-01T00:00:00.000Z";

export function binomialStatsInput(options: {
  readonly controlN: number;
  readonly treatmentN: number;
  readonly controlConversions: number;
  readonly treatmentConversions: number;
  readonly horizon?: "sequential" | "fixed";
  readonly sampleSizeLocked?: number;
  readonly includeGuardrail?: boolean;
}): StatsInput {
  const exposures = [
    ...exposuresForVariant("control", options.controlN),
    ...exposuresForVariant("treatment", options.treatmentN),
  ];
  const metric_values = [
    ...conversionRows("conversion", "control", options.controlConversions),
    ...conversionRows("conversion", "treatment", options.treatmentConversions),
  ];

  if (options.includeGuardrail === true) {
    metric_values.push(
      ...conversionRows("guardrail_conversion", "control", options.controlConversions),
      ...conversionRows("guardrail_conversion", "treatment", options.treatmentConversions),
    );
  }

  return {
    run_id: ENGINE_RUN_ID,
    confidence_level: 0.95,
    horizon: options.horizon ?? "sequential",
    sample_size_locked: options.sampleSizeLocked,
    allocation: { control: 50, treatment: 50 },
    control_variant: "control",
    decision_family: [{ metric_id: "conversion", variant: "treatment" }],
    guardrail_decisions:
      options.includeGuardrail === true
        ? [
            {
              metric_id: "guardrail_conversion",
              variant: "treatment",
              // Above the fixture's Fieller lower bound (~29.99%) so this stays
              // a breach case. The delta-method interval this replaced ran much
              // wider on the low side and breached at 10.
              downside_threshold_pct: 35,
              guardrail_locked_at_run_start: true,
              threshold_locked_at_run_start: true,
            },
          ]
        : [],
    metric_variance_config: [],
    exposures,
    metric_values,
  };
}

export function exposure(variant: string, targeting_key_hash: string): DedupeExposureRow {
  return {
    app_id: "app_1",
    targeting_key_hash,
    environment_id: "env_1",
    id_type: "user",
    run_id: ENGINE_RUN_ID,
    variant,
    first_exposure_ts: ENGINE_TS,
    window_anchor: ENGINE_TS,
  };
}

function metricRow(
  metric_id: string,
  variant: string,
  index: number,
  value: number,
): PerEntityMetricRow {
  return {
    targeting_key_hash: entityId(variant, index),
    run_id: ENGINE_RUN_ID,
    metric_id,
    metric_type: "binomial",
    value,
    in_window: true,
  };
}

function exposuresForVariant(variant: string, count: number): DedupeExposureRow[] {
  return Array.from({ length: count }, (_unused, index) =>
    exposure(variant, entityId(variant, index)),
  );
}

function conversionRows(
  metricId: string,
  variant: string,
  conversions: number,
): PerEntityMetricRow[] {
  return Array.from({ length: conversions }, (_unused, index) =>
    metricRow(metricId, variant, index, 1),
  );
}

function entityId(variant: string, index: number): string {
  return `${variant}_${index}`;
}
