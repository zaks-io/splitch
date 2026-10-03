import type { SrmProcedure } from "./analysis-version-policy";
import { computeSequentialSrm } from "./sequential-srm";
import { sumCounts } from "./srm-counts";
import { SRM_MISMATCH_P_VALUE } from "./srm-checker-threshold";

export interface SrmTestResult {
  readonly p_value: number;
  readonly is_mismatch: boolean;
}

/**
 * Map cumulative arm counts through the Lindon-Malek martingale. A single
 * watermark snapshot is one look on the sufficient statistic; Ville's inequality
 * still controls Type I under continuous monitoring of that wealth process.
 */
export function sequentialSrmAgainstAllocation(
  observed: Readonly<Record<string, number>>,
  allocation: Readonly<Record<string, number>>,
): SrmTestResult {
  const totalObserved = sumCounts(observed);
  if (totalObserved === 0) {
    return { p_value: 1, is_mismatch: false };
  }

  const result = computeSequentialSrm({
    allocation,
    observations: { mode: "cumulative", snapshots: [observed] },
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
