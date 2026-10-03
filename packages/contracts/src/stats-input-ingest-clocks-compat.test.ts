import { describe, expect, it } from "vitest";
import {
  ActivationRowSchema,
  DedupeExposureRowSchema,
  StatsInputSchema,
} from "./stats-input-contract";

/**
 * Deploy-order compat: Tinybird can emit ingest clocks before Workers require
 * them. .strict() schemas must accept both old-pipe and new-pipe shapes.
 * analysis-v2 fails loud when clocks are absent; v1/legacy ignore them.
 */
const exposureRow = {
  app_id: "app_1",
  targeting_key_hash: "tkh_1",
  environment_id: "env_1",
  id_type: "user",
  run_id: "run_1",
  variant: "treatment",
  first_exposure_ts: "2026-07-01T00:00:00.000Z",
  window_anchor: "2026-07-01T00:00:00.000Z",
};

const activationRow = {
  targeting_key_hash: "tkh_1",
  run_id: "run_1",
  activation_ts: "2026-07-01T00:05:00.000Z",
  counterfactual: false,
  activated: true,
};

const statsInputBase = {
  run_id: "run_1",
  allocation: { control: 50, treatment: 50 },
  control_variant: "control",
  decision_family: [{ metric_id: "metric_1", variant: "treatment" }],
  exposures: [exposureRow],
  metric_values: [
    {
      targeting_key_hash: "tkh_1",
      run_id: "run_1",
      metric_id: "metric_1",
      metric_type: "binomial" as const,
      value: 1,
      in_window: true,
    },
  ],
};

describe("analysis ingest clock deploy compatibility", () => {
  it("accepts Exposure rows with first_ingest_ts (old reader / new pipe)", () => {
    const row = DedupeExposureRowSchema.parse({
      ...exposureRow,
      first_ingest_ts: "2026-07-01T00:00:00.000Z",
    });

    expect(row.first_ingest_ts).toBe("2026-07-01T00:00:00.000Z");
  });

  it("accepts Exposure rows without first_ingest_ts (new reader / old pipe)", () => {
    const row = DedupeExposureRowSchema.parse(exposureRow);

    expect(row.first_ingest_ts).toBeUndefined();
  });

  it("accepts Activation rows with activation_ingest_ts (old reader / new pipe)", () => {
    const row = ActivationRowSchema.parse({
      ...activationRow,
      activation_ingest_ts: "2026-07-01T00:05:00.000Z",
    });

    expect(row.activation_ingest_ts).toBe("2026-07-01T00:05:00.000Z");
  });

  it("accepts Activation rows without activation_ingest_ts (new reader / old pipe)", () => {
    const row = ActivationRowSchema.parse(activationRow);

    expect(row.activation_ingest_ts).toBeUndefined();
  });

  it("accepts Activation rows with null activation_ingest_ts (Tinybird null emission)", () => {
    const row = ActivationRowSchema.parse({
      ...activationRow,
      activation_ingest_ts: null,
    });

    expect(row.activation_ingest_ts).toBeNull();
  });

  it("lets analysis-v1 ignore missing ingest clocks", () => {
    expect(
      StatsInputSchema.safeParse({
        ...statsInputBase,
        analysis_version: "analysis-v1",
        activation_rows: [activationRow],
      }).success,
    ).toBe(true);
  });

  it("lets analysis-v1 accept null activation_ingest_ts", () => {
    expect(
      StatsInputSchema.safeParse({
        ...statsInputBase,
        analysis_version: "analysis-v1",
        activation_rows: [{ ...activationRow, activation_ingest_ts: null }],
      }).success,
    ).toBe(true);
  });

  it("fails loud when analysis-v2 Exposures omit first_ingest_ts", () => {
    expect(
      StatsInputSchema.safeParse({
        ...statsInputBase,
        analysis_version: "analysis-v2",
      }).success,
    ).toBe(false);
  });

  it("fails loud when analysis-v2 Activations omit activation_ingest_ts", () => {
    expect(
      StatsInputSchema.safeParse({
        ...statsInputBase,
        analysis_version: "analysis-v2",
        exposures: [{ ...exposureRow, first_ingest_ts: "2026-07-01T00:00:00.000Z" }],
        activation_rows: [activationRow],
      }).success,
    ).toBe(false);
  });

  it("fails loud when analysis-v2 Activations carry null activation_ingest_ts", () => {
    expect(
      StatsInputSchema.safeParse({
        ...statsInputBase,
        analysis_version: "analysis-v2",
        exposures: [{ ...exposureRow, first_ingest_ts: "2026-07-01T00:00:00.000Z" }],
        activation_rows: [{ ...activationRow, activation_ingest_ts: null }],
      }).success,
    ).toBe(false);
  });

  it("accepts analysis-v2 when both ingest clocks are present", () => {
    expect(
      StatsInputSchema.safeParse({
        ...statsInputBase,
        analysis_version: "analysis-v2",
        exposures: [{ ...exposureRow, first_ingest_ts: "2026-07-01T00:00:00.000Z" }],
        activation_rows: [{ ...activationRow, activation_ingest_ts: "2026-07-01T00:05:00.000Z" }],
      }).success,
    ).toBe(true);
  });
});
