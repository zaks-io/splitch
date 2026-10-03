import type { SrmProcedure } from "./analysis-version-policy";
import { computeSequentialSrm } from "./sequential-srm";
import { buildDailyCumulativeSnapshots, type SrmPathEntity } from "./srm-observation-path";
import { SRM_MISMATCH_P_VALUE } from "./srm-checker-threshold";

export interface SrmTestResult {
  readonly p_value: number;
  readonly is_mismatch: boolean;
}

/**
 * Reconstruct the daily first-Exposure checkpoint path from the current
 * watermarked Entities and evaluate the Lindon-Malek martingale along it.
 * Reported p is the running minimum along that path (sticky alarm).
 */
export function sequentialSrmAlongEntityPath(
  entities: readonly SrmPathEntity[],
  allocation: Readonly<Record<string, number>>,
  variants: readonly string[],
): SrmTestResult {
  if (entities.length === 0) {
    return { p_value: 1, is_mismatch: false };
  }

  const snapshots = buildDailyCumulativeSnapshots(entities, variants);
  const result = computeSequentialSrm({
    allocation,
    observations: { mode: "cumulative", snapshots },
    alpha: SRM_MISMATCH_P_VALUE,
  });
  return {
    p_value: result.anytime_p_value,
    is_mismatch: result.threshold_crossed,
  };
}

export function resolveSrmProcedure(procedure: SrmProcedure | undefined): SrmProcedure {
  if (procedure === undefined) {
    return "chi_square";
  }
  if (procedure === "chi_square" || procedure === "sequential_martingale") {
    return procedure;
  }
  throw new Error(
    `srm_procedure must be chi_square or sequential_martingale; received ${JSON.stringify(procedure)}.`,
  );
}
