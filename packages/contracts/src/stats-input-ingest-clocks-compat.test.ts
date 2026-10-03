import { describe, expect, it } from "vitest";
import { ActivationRowSchema, DedupeExposureRowSchema } from "./stats-input-contract";

/**
 * Deploy-order compat: Tinybird can emit ingest clocks before Workers require
 * them. .strict() schemas must accept both old-pipe and new-pipe shapes.
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
});
