import type { PipeParams, TinybirdReadOptions, TinybirdReadTransport } from "./tinybird";

export const APP_ID = "app_checkout";
export const OTHER_APP_ID = "app_other";
export const ENVIRONMENT_ID = "env_prod";
export const EXPERIMENT_ID = "exp_checkout_banner";
export const RUN_ID = "run_checkout_banner_1";

export type RowsByPipe = Record<string, readonly unknown[]>;

export class FakeTinybird implements TinybirdReadTransport {
  readonly calls: {
    pipeName: string;
    params: PipeParams;
    options: TinybirdReadOptions | undefined;
  }[] = [];

  constructor(private readonly rows: RowsByPipe = rowsByPipe()) {}

  async readPipe(
    pipeName: string,
    params: PipeParams,
    options?: TinybirdReadOptions,
  ): Promise<readonly unknown[]> {
    this.calls.push({ pipeName, params: { ...params }, options });
    return rowsForPipe(this.rows, pipeName);
  }
}

export function rowsForPipe(rows: RowsByPipe, pipeName: string): readonly unknown[] {
  if (pipeName !== "analysis_run_bootstrap" || rows[pipeName] !== undefined) {
    return rows[pipeName] ?? [];
  }
  return [
    ...(rows.analysis_run_inputs ?? []).map((payload) => ({
      row_type: "run",
      payload: JSON.stringify(runBootstrapTuple(payload)),
    })),
    ...(rows.analysis_deduped_exposures ?? []).map((payload) => ({
      row_type: "exposure",
      payload: JSON.stringify(exposureBootstrapTuple(payload)),
    })),
  ];
}

function runBootstrapTuple(payload: unknown): unknown[] {
  const row = payload as Record<string, unknown>;
  return [
    row.run_id,
    row.confidence_level,
    row.horizon,
    row.target_n ?? null,
    row.sample_size_locked ?? null,
    row.allocation,
    row.control_variant,
    row.control_variant_id ?? null,
    row.activation_metric_id ?? null,
    row.decision_family,
    row.guardrail_decisions,
    row.metric_query_config ?? "[]",
    row.metric_variance_config ?? "[]",
    row.dimensions ?? "[]",
    row.started_at,
  ];
}

function exposureBootstrapTuple(payload: unknown): unknown[] {
  const row = payload as Record<string, unknown>;
  return [
    row.app_id,
    row.environment_id,
    row.id_type,
    row.run_id,
    row.targeting_key_hash,
    row.variant,
    row.first_exposure_ts,
    row.window_anchor ?? row.first_exposure_ts,
  ];
}

export function rowsByPipe(): RowsByPipe {
  return {
    analysis_run_inputs: [
      {
        run_id: RUN_ID,
        confidence_level: 0.95,
        horizon: "sequential",
        allocation: JSON.stringify({ control: 50, treatment: 50 }),
        control_variant: "control",
        activation_metric_id: null,
        started_at: "2026-07-01T00:00:00.000Z",
        decision_family: JSON.stringify([{ metric_id: "conversion", variant: "treatment" }]),
        guardrail_decisions: JSON.stringify([]),
        metric_query_config: JSON.stringify([
          {
            metric_id: "conversion",
            metric_type: "binomial",
            event_definition_id: "event_definition_conversion",
            window_duration_ms: 259_200_000,
            cuped_lookback_ms: 604_800_000,
          },
        ]),
      },
    ],
    analysis_deduped_exposures: [
      exposure("control", "control_0"),
      exposure("control", "control_1"),
      exposure("treatment", "treatment_0"),
      exposure("treatment", "treatment_1"),
    ],
    analysis_metric_values_batch: [
      metricValue("control_0", 1),
      metricValue("treatment_0", 1),
      metricValue("treatment_1", 1),
    ],
    analysis_pre_period_covariates_batch: [],
    analysis_activation_rows: [],
  };
}

function exposure(variant: string, targetingKeyHash: string) {
  return {
    app_id: APP_ID,
    environment_id: ENVIRONMENT_ID,
    id_type: "user",
    targeting_key_hash: targetingKeyHash,
    run_id: RUN_ID,
    variant,
    first_exposure_ts: "2026-07-01T00:00:00.000Z",
    window_anchor: "2026-07-01T00:00:00.000Z",
  };
}

function metricValue(targetingKeyHash: string, value: number) {
  return {
    targeting_key_hash: targetingKeyHash,
    run_id: RUN_ID,
    metric_id: "conversion",
    metric_type: "binomial",
    value,
    in_window: 1,
  };
}
