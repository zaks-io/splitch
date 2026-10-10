import { SRM_MISMATCH_P_VALUE } from "./srm-checker-threshold";
import {
  applySequentialSrmIncrements,
  createSequentialSrmWealthState,
  tryWealthFromLog,
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
 * outcomes in arrival order. Increment batches may be sparse (omitted arms mean
 * zero arrivals). Cumulative snapshots must name every declared arm, reject
 * null/undefined counts, and be append-only: per-arm counts never decrease.
 * The wealth process is a nonnegative martingale under the declared allocation,
 * so continuous monitoring does not inflate Type I error.
 *
 * Wealth overflow contract. Evidence is always preserved as `log_wealth`.
 * Numeric `wealth` is `exp(log_wealth)` when finite, otherwise `null`. We never
 * return nonfinite wealth (`Infinity` JSON-serializes as `null` and would erase
 * the distinction between overflow and a missing value).
 *
 * Within one `computeSequentialSrm` call, cumulative snapshots must stay
 * append-only. Across Results reads, analysis-v2 does not feed revised totals
 * into a live filtration: `checkSrmHealth` rebuilds the Entity arrival path
 * from the current watermarked dataset (Exposure by first_ingest_ts, activated
 * by pairwise eligibility ingest) and re-evaluates after every
 * arrival. Quarantine to `__multiple__` removes an Entity from the cleaned set;
 * the next read recomputes the path from remaining Entities ordered by their
 * unchanged first_ingest_ts, so a late single-Entity conflict cannot clear a
 * sticky early mismatch among the survivors. analysis-v2 selects this
 * martingale for Exposure and activated-population SRM via
 * `analysisVersionPolicy`; analysis-v1 and legacy keep chi-square.
 */
export const SEQUENTIAL_SRM_SOURCE = {
  family: "dirichlet-multinomial-mixture-martingale",
  references: [
    "https://proceedings.neurips.cc/paper/2022/hash/12f3bd5d2b7d93eadc1bf508a0872dc2-Abstract.html",
  ],
} as const;

export const SEQUENTIAL_SRM_DEFAULT_ALPHA = SRM_MISMATCH_P_VALUE;
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
  /** Finite exp(log_wealth), or null when the exponential overflows. */
  readonly wealth: number | null;
  /** Log-space martingale wealth; always finite when the computation succeeds. */
  readonly log_wealth: number;
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
    wealth: tryWealthFromLog(state.logWealth),
    log_wealth: state.logWealth,
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
    const current = countVectorFromRecord(snapshot, variants, `cumulative snapshot ${index}`, {
      requireAllArms: true,
    });
    batches.push(subtractCountVectors(current, previous, variants));
    previous = current;
  }
  return batches;
}
