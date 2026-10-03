import { describe, expect, it } from "vitest";
import type { ActivationRow, DedupeExposureRow } from "@splitch/contracts";
import { analyzeStats } from "./stats-engine";
import { binomialStatsInput } from "./stats-engine-test-helpers";

describe("StatsEngine.analyze legacy/v1 without ingest clocks", () => {
  it("analyzes gated Runs with neither ingest clock present", async () => {
    // Chi-square must never require first_ingest_ts / activation_ingest_ts; fixtures
    // that always populate clocks would mask a regression that throws on real
    // legacy/v1 inputs from an older pipe.
    for (const analysisVersion of ["legacy-unversioned", "analysis-v1"] as const) {
      const base = binomialStatsInput({
        controlN: 100,
        treatmentN: 100,
        controlConversions: 20,
        treatmentConversions: 40,
        analysisVersion,
      });
      const exposures: DedupeExposureRow[] = base.exposures.map((row) => {
        const { first_ingest_ts: _omit, ...withoutClock } = row;
        return withoutClock;
      });
      const activation_rows: ActivationRow[] = exposures.map((row) => ({
        targeting_key_hash: row.targeting_key_hash,
        run_id: row.run_id,
        activation_ts: "2026-07-01T00:05:00.000Z",
        counterfactual: false,
        activated: true,
      }));

      const output = await analyzeStats({ ...base, exposures, activation_rows });

      expect(output.srm.srm_is_mismatch).toBe(false);
      expect(output.srm.activated_srm_mismatch).toBe(false);
      expect(output.health.activation_rates).toMatchObject({ control: 1, treatment: 1 });
      expect(exposures.every((row) => !("first_ingest_ts" in row))).toBe(true);
      expect(activation_rows.every((row) => row.activation_ingest_ts === undefined)).toBe(true);
    }
  });
});
