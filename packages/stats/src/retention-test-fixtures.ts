import type { DedupeExposureRow, PerEntityMetricRow, StatsInput } from "@splitch/contracts";
import { ANALYSIS_V1_VERSION } from "@splitch/contracts";

export const ANCHOR = "2026-07-01T00:00:00.000Z";
export const MATURE_WATERMARK = "2026-07-08T00:00:00.000Z";
export const IMMATURE_WATERMARK = "2026-07-04T00:00:00.000Z";
const HORIZON_END_MS = 2 * 86_400_000;

export function emptyRetentionRowsInput(data_watermark: string | undefined): StatsInput {
  return {
    ...retentionAndBinomialInput({
      data_watermark,
      lateAnchor: "2026-07-03T00:00:00.000Z",
    }),
    decision_family: [{ metric_id: "d7_retained", variant: "treatment" }],
    metric_values: [],
  };
}

export function staggeredActivationInput(data_watermark: string): StatsInput {
  const horizonEndMs = 86_400_000;
  const earlyExposure = "2026-07-01T00:00:00.000Z";
  const lateExposure = "2026-07-01T00:00:01.000Z";
  const earlyActivation = "2026-07-06T00:00:00.000Z";
  const lateActivation = "2026-07-01T00:00:02.000Z";
  const entities = [
    {
      variant: "control",
      key: "c_early_exp",
      first_exposure_ts: earlyExposure,
      window_anchor: earlyActivation,
      activation_ts: earlyActivation,
    },
    {
      variant: "control",
      key: "c_late_exp",
      first_exposure_ts: lateExposure,
      window_anchor: lateActivation,
      activation_ts: lateActivation,
    },
    {
      variant: "treatment",
      key: "t_early_exp",
      first_exposure_ts: earlyExposure,
      window_anchor: earlyActivation,
      activation_ts: earlyActivation,
    },
    {
      variant: "treatment",
      key: "t_late_exp",
      first_exposure_ts: lateExposure,
      window_anchor: lateActivation,
      activation_ts: lateActivation,
    },
  ];
  return {
    run_id: "run_retention",
    analysis_version: ANALYSIS_V1_VERSION,
    confidence_level: 0.95,
    horizon: "fixed",
    sample_size_locked: 1,
    allocation: { control: 50, treatment: 50 },
    control_variant: "control",
    decision_family: [{ metric_id: "d7_retained", variant: "treatment" }],
    guardrail_decisions: [],
    metric_variance_config: [],
    data_watermark,
    metric_retention_horizons: [
      { metric_id: "d7_retained", horizon_start_ms: 0, horizon_end_ms: horizonEndMs },
    ],
    exposures: entities.map((entity) => ({
      app_id: "app_1",
      targeting_key_hash: entity.key,
      environment_id: "env_1",
      id_type: "user",
      run_id: "run_retention",
      variant: entity.variant,
      first_exposure_ts: entity.first_exposure_ts,
      window_anchor: entity.window_anchor,
    })),
    activation_rows: entities.map((entity) => ({
      targeting_key_hash: entity.key,
      run_id: "run_retention",
      activation_ts: entity.activation_ts,
      counterfactual: false,
      activated: true,
    })),
    metric_values: [],
  };
}

export function retentionAndBinomialInput(options: {
  data_watermark: string | undefined;
  lateAnchor: string;
}): StatsInput {
  const exposures: DedupeExposureRow[] = [
    exposure("control", "c_early", ANCHOR),
    exposure("control", "c_late", options.lateAnchor),
    exposure("treatment", "t_early", ANCHOR),
    exposure("treatment", "t_late", options.lateAnchor),
  ];
  const metric_values: PerEntityMetricRow[] = [
    metricRow("conversion", "binomial", "c_early", 1),
    metricRow("conversion", "binomial", "t_early", 1),
    metricRow("d7_retained", "retention", "c_early", 1),
    metricRow("d7_retained", "retention", "t_early", 1),
  ];
  return {
    run_id: "run_retention",
    analysis_version: ANALYSIS_V1_VERSION,
    confidence_level: 0.95,
    horizon: "sequential",
    allocation: { control: 50, treatment: 50 },
    control_variant: "control",
    decision_family: [
      { metric_id: "conversion", variant: "treatment" },
      { metric_id: "d7_retained", variant: "treatment" },
    ],
    guardrail_decisions: [],
    metric_variance_config: [],
    ...(options.data_watermark === undefined ? {} : { data_watermark: options.data_watermark }),
    metric_retention_horizons: [
      { metric_id: "d7_retained", horizon_start_ms: 0, horizon_end_ms: HORIZON_END_MS },
    ],
    exposures,
    metric_values,
  };
}

export function exposure(
  variant: string,
  targeting_key_hash: string,
  anchor: string,
): DedupeExposureRow {
  return {
    app_id: "app_1",
    targeting_key_hash,
    environment_id: "env_1",
    id_type: "user",
    run_id: "run_retention",
    variant,
    first_exposure_ts: anchor,
    window_anchor: anchor,
  };
}

function metricRow(
  metric_id: string,
  metric_type: "binomial" | "retention",
  targeting_key_hash: string,
  value: number,
): PerEntityMetricRow {
  return {
    targeting_key_hash,
    run_id: "run_retention",
    metric_id,
    metric_type,
    value,
    in_window: true,
  };
}
