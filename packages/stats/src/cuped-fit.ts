import { mean } from "./variance-math";
import type { EntityAggregate } from "./variance-estimator-types";

interface CupedFit {
  readonly theta: number;
  readonly xBar: number;
}

interface CoveredArm {
  readonly y: readonly number[];
  readonly x: readonly number[];
}

export interface CupedArm {
  readonly entities: readonly EntityAggregate[];
  readonly values: ReadonlyMap<string, number>;
}

/**
 * Fit one CUPED adjustment across every arm in the Run and apply it.
 *
 * All arms must share one slope and one centering constant. Centering each arm
 * on its own covariate mean makes the adjustment sum to zero inside the arm, so
 * the lift keeps the full covariate imbalance while the variance drops to the
 * residual: the interval narrows around an uncorrected estimate. Deng, Xu,
 * Kohavi and Walker (WSDM 2013, s3.2) define the adjustment against the grand
 * mean for exactly this reason.
 *
 * The fit spans every arm rather than one (Control, Treatment) pair so that a
 * Run's Control arm has a single adjusted value, not one per Treatment it is
 * compared against.
 */
export function adjustCupedArms(arms: readonly CupedArm[]): EntityAggregate[][] {
  const fit = fitCuped(arms.map((arm) => coveredArm(arm.entities, arm.values)));

  if (!fit) {
    return arms.map((arm) => arm.entities.map((entity) => ({ ...entity })));
  }

  return arms.map((arm) => adjustArm(arm.entities, arm.values, fit));
}

/**
 * The slope uses within-arm-centered cross products so a real treatment effect
 * cannot leak into it, while the centering constant is the pooled covariate
 * mean.
 */
function fitCuped(arms: readonly CoveredArm[]): CupedFit | null {
  const pooledX = arms.flatMap((arm) => [...arm.x]);
  if (pooledX.length === 0) {
    return null;
  }

  let crossProduct = 0;
  let xSumSquares = 0;
  for (const arm of arms) {
    const centered = centeredCrossProducts(arm);
    crossProduct += centered.crossProduct;
    xSumSquares += centered.xSumSquares;
  }

  return {
    theta: xSumSquares === 0 ? 0 : crossProduct / xSumSquares,
    xBar: mean(pooledX),
  };
}

function centeredCrossProducts(arm: CoveredArm): {
  crossProduct: number;
  xSumSquares: number;
} {
  if (arm.x.length < 2) {
    return { crossProduct: 0, xSumSquares: 0 };
  }

  const xBar = mean(arm.x);
  const yBar = mean(arm.y);
  let crossProduct = 0;
  let xSumSquares = 0;

  for (const [index, xValue] of arm.x.entries()) {
    const yValue = arm.y[index];
    if (yValue === undefined) {
      throw new Error("CUPED fit requires matched covariate and metric values.");
    }
    crossProduct += (yValue - yBar) * (xValue - xBar);
    xSumSquares += (xValue - xBar) ** 2;
  }

  return { crossProduct, xSumSquares };
}

function coveredArm(
  entities: readonly EntityAggregate[],
  covariates: ReadonlyMap<string, number>,
): CoveredArm {
  const covered = entities.filter((entity) => covariates.has(entity.targeting_key_hash));

  return {
    y: covered.map((entity) => entity.value),
    x: covered.map((entity) => covariateValue(covariates, entity.targeting_key_hash)),
  };
}

function adjustArm(
  entities: readonly EntityAggregate[],
  covariates: ReadonlyMap<string, number>,
  fit: CupedFit,
): EntityAggregate[] {
  return entities.map((entity) => {
    const xValue = covariates.get(entity.targeting_key_hash);
    if (xValue === undefined) {
      return { ...entity };
    }
    return {
      ...entity,
      value: entity.value - fit.theta * (xValue - fit.xBar),
      cuped_adjusted: true,
    };
  });
}

function covariateValue(values: ReadonlyMap<string, number>, entityId: string): number {
  const value = values.get(entityId);
  if (value === undefined) {
    throw new Error("CUPED adjustment missing covered covariate value.");
  }
  return value;
}
