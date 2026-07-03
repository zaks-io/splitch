import type { PipeParams, TinybirdReadTransport } from "./tinybird.js";

export const APP_ID = "app_checkout";
export const OTHER_APP_ID = "app_other";
export const ENVIRONMENT_ID = "env_prod";
export const EXPERIMENT_ID = "exp_checkout_banner";
export const RUN_ID = "run_checkout_banner_1";

export type RowsByPipe = Record<string, readonly unknown[]>;

export class FakeTinybird implements TinybirdReadTransport {
  readonly calls: { pipeName: string; params: PipeParams }[] = [];

  constructor(private readonly rows: RowsByPipe = rowsByPipe()) {}

  async readPipe(pipeName: string, params: PipeParams): Promise<readonly unknown[]> {
    this.calls.push({ pipeName, params: { ...params } });
    return this.rows[pipeName] ?? [];
  }
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
        decision_family: JSON.stringify([{ metric_id: "conversion", variant: "treatment" }]),
        guardrail_decisions: JSON.stringify([]),
      },
    ],
    analysis_deduped_exposures: [
      exposure("control", "control_0"),
      exposure("control", "control_1"),
      exposure("treatment", "treatment_0"),
      exposure("treatment", "treatment_1"),
    ],
    analysis_metric_values: [
      metricValue("control_0", 1),
      metricValue("treatment_0", 1),
      metricValue("treatment_1", 1),
    ],
    analysis_pre_period_covariates: [],
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
