import {
  applySequentialSrmIncrements,
  createSequentialSrmWealthState,
  wealthFromLog,
} from "./sequential-srm-math";
import {
  countVectorFromRecord,
  parseSequentialSrmAllocation,
  parseSequentialSrmAlpha,
  parseSequentialSrmConcentration,
  subtractCountVectors,
} from "./sequential-srm-validate";

/**
 * Sequential sample-ratio-mismatch test: Dirichlet-multinomial mixture martingale
 * of Lindon and Malek, NeurIPS 2022.
 *
 * Observation contract. Each increment is an iid multinomial count of newly
 * arrived Entities, or equivalently a batch of Multinomial(1, theta) Assignment
 * outcomes in arrival order. Cumulative snapshots must be append-only: per-arm
 * counts never decrease. The wealth process is a nonnegative martingale under
 * the declared allocation, so continuous monitoring does not inflate Type I
 * error.
 *
 * Revising earlier counts violates the contract. Moving an Entity into the
 * `__multiple__` quarantine after it was already counted in an arm is one such
 * revision. Reconciling those corrections into the filtration is a later slice.
 * This function is not wired into the decision gate.
 */
export const SEQUENTIAL_SRM_SOURCE = {
  family: "dirichlet-multinomial-mixture-martingale",
  references: [
    "https://proceedings.neurips.cc/paper/2022/hash/12f3bd5d2b7d93eadc1bf508a0872dc2-Abstract.html",
  ],
} as const;

export const SEQUENTIAL_SRM_DEFAULT_ALPHA = 0.001;
export const SEQUENTIAL_SRM_DEFAULT_CONCENTRATION = 100;

export type SequentialSrmObservations =
  | {
      readonly mode: "increments";
      readonly batches: readonly Readonly<Record<string, number>>[];
    }
  | {
      readonly mode: "cumulative";
      readonly snapshots: readonly Readonly<Record<string, number>>[];
    };

export interface SequentialSrmInput {
  readonly allocation: Readonly<Record<string, number>>;
  readonly observations: SequentialSrmObservations;
  readonly alpha?: number;
  readonly concentration?: number;
}

export interface SequentialSrmResult {
  readonly wealth: number;
  readonly anytime_p_value: number;
  readonly threshold_crossed: boolean;
  readonly first_cross_n: number | null;
  readonly total_n: number;
  readonly counts: Readonly<Record<string, number>>;
}

export function computeSequentialSrm(input: SequentialSrmInput): SequentialSrmResult {
  const { variants, theta } = parseSequentialSrmAllocation(input.allocation);
  const alpha = parseSequentialSrmAlpha(input.alpha, SEQUENTIAL_SRM_DEFAULT_ALPHA);
  const concentration = parseSequentialSrmConcentration(
    input.concentration,
    SEQUENTIAL_SRM_DEFAULT_CONCENTRATION,
  );
  const state = createSequentialSrmWealthState(theta, concentration);
  const totals = variants.map(() => 0);

  for (const increment of incrementBatches(input.observations, variants)) {
    applySequentialSrmIncrements(state, increment, theta, alpha);
    for (let index = 0; index < increment.length; index += 1) {
      totals[index] = (totals[index] ?? 0) + (increment[index] ?? 0);
    }
  }

  const anytimePValue = state.minInvWealth;
  return {
    wealth: wealthFromLog(state.logWealth),
    anytime_p_value: anytimePValue,
    threshold_crossed: anytimePValue <= alpha,
    first_cross_n: state.firstCrossN,
    total_n: state.n,
    counts: Object.fromEntries(variants.map((variant, index) => [variant, totals[index] ?? 0])),
  };
}

function incrementBatches(
  observations: SequentialSrmObservations,
  variants: readonly string[],
): number[][] {
  if (observations.mode === "increments") {
    return observations.batches.map((batch, index) =>
      countVectorFromRecord(batch, variants, `increment batch ${index}`),
    );
  }

  const batches: number[][] = [];
  let previous = variants.map(() => 0);
  for (const [index, snapshot] of observations.snapshots.entries()) {
    const current = countVectorFromRecord(snapshot, variants, `cumulative snapshot ${index}`);
    batches.push(subtractCountVectors(current, previous, variants));
    previous = current;
  }
  return batches;
}
