import type { SrmProcedure } from "./analysis-version-policy";
import {
  applySequentialSrmIncrements,
  createSequentialSrmWealthState,
} from "./sequential-srm-math";
import { SEQUENTIAL_SRM_DEFAULT_CONCENTRATION } from "./sequential-srm";
import { parseSequentialSrmAllocation } from "./sequential-srm-validate";
import { sortEntitiesByArrival, type SrmPathEntity } from "./srm-observation-path";
import { SRM_MISMATCH_P_VALUE } from "./srm-checker-threshold";

export interface SrmTestResult {
  readonly p_value: number;
  readonly is_mismatch: boolean;
}

/**
 * Evaluate the Lindon-Malek martingale along true Entity arrival order.
 * Reported p is the running minimum after every arrival (sticky alarm).
 * Mutates `entities` into sorted arrival order (caller owns the array).
 */
export function sequentialSrmAlongEntityPath(
  entities: SrmPathEntity[],
  allocation: Readonly<Record<string, number>>,
): SrmTestResult {
  if (entities.length === 0) {
    return { p_value: 1, is_mismatch: false };
  }

  sortEntitiesByArrival(entities);
  const { variants, theta } = parseSequentialSrmAllocation(allocation);
  const variantIndex = new Map(variants.map((variant, index) => [variant, index]));
  const state = createSequentialSrmWealthState(theta, SEQUENTIAL_SRM_DEFAULT_CONCENTRATION);
  const increment = variants.map(() => 0);

  for (const entity of entities) {
    const index = variantIndex.get(entity.variant);
    if (index === undefined) {
      throw new Error(
        `SRM observation path entity variant ${entity.variant} is missing from allocation.`,
      );
    }
    increment[index] = 1;
    applySequentialSrmIncrements(state, increment, theta, SRM_MISMATCH_P_VALUE);
    increment[index] = 0;
  }

  return {
    p_value: state.minInvWealth,
    is_mismatch: state.minInvWealth <= SRM_MISMATCH_P_VALUE,
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
