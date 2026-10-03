import type { ActivationRow, DedupeExposureRow } from "@splitch/contracts";

export const SRM_TEST_RUN_ID = "run_srm_unit";
const SRM_TEST_BASE_TS = "2026-07-01T00:00:00.000Z";
const SRM_TEST_ACTIVATION_TS = "2026-07-01T00:05:00.000Z";

export function omitField(input: Record<string, unknown>, field: string): Record<string, unknown> {
  const copy = { ...input };
  delete copy[field];
  return copy;
}

export function exposures(variant: string, count: number): DedupeExposureRow[] {
  return exposuresOnDay(variant, count, SRM_TEST_BASE_TS);
}

export function exposuresOnDay(
  variant: string,
  count: number,
  firstExposureTs: string,
  indexOffset = 0,
): DedupeExposureRow[] {
  return Array.from({ length: count }, (_, index) =>
    exposureOnDay(variant, `${variant}_${indexOffset + index}`, firstExposureTs),
  );
}

export function exposure(variant: string, targeting_key_hash: string): DedupeExposureRow {
  return exposureOnDay(variant, targeting_key_hash, SRM_TEST_BASE_TS);
}

export function exposureOnDay(
  variant: string,
  targeting_key_hash: string,
  firstExposureTs: string,
): DedupeExposureRow {
  return {
    app_id: "app_1",
    targeting_key_hash,
    environment_id: "env_1",
    id_type: "user",
    run_id: SRM_TEST_RUN_ID,
    variant,
    first_exposure_ts: firstExposureTs,
    window_anchor: firstExposureTs,
  };
}

export function activationRows(exposureRows: readonly DedupeExposureRow[]): ActivationRow[] {
  return exposureRows.map((row) => ({
    targeting_key_hash: row.targeting_key_hash,
    run_id: SRM_TEST_RUN_ID,
    activation_ts: SRM_TEST_ACTIVATION_TS,
    counterfactual: false,
    activated: true,
  }));
}
