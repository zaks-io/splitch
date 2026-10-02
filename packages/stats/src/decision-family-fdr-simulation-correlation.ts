/** Declared pairwise Metric correlation under the shared-factor design. */
export const FAMILY_FDR_SIM_CORRELATION = 0.6;
export const FAMILY_FDR_SIM_CORRELATION_CHECK_N = 20_000;
export const FAMILY_FDR_SIM_CORRELATION_TOLERANCE = 0.03;

/**
 * Shared-factor loadings such that Corr(metric_i, metric_j) equals `correlation`
 * when residuals are independent unit normals: shared = sqrt(rho), residual = sqrt(1 - rho).
 */
export function familyFdrSimFactorLoadings(correlation: number): {
  sharedLoading: number;
  residualLoading: number;
} {
  if (!Number.isFinite(correlation) || correlation < 0 || correlation >= 1) {
    throw new Error(
      `family FDR simulation correlation must be in [0, 1); received ${correlation}.`,
    );
  }
  return {
    sharedLoading: Math.sqrt(correlation),
    residualLoading: Math.sqrt(1 - correlation),
  };
}

/**
 * Draws null Metric pairs under the shared-factor design and fails loud when the
 * sample Pearson correlation drifts from the declared correlation.
 */
export function assertGeneratedMetricCorrelation(
  rng: () => number,
  correlation: number,
  sampleSize: number,
  absoluteTolerance: number,
): number {
  if (!Number.isInteger(sampleSize) || sampleSize < 2) {
    throw new Error("generated correlation check requires sampleSize >= 2.");
  }
  if (!Number.isFinite(absoluteTolerance) || absoluteTolerance < 0) {
    throw new Error(
      "generated correlation check absoluteTolerance must be a non-negative finite number.",
    );
  }

  const { sharedLoading, residualLoading } = familyFdrSimFactorLoadings(correlation);
  const left: number[] = [];
  const right: number[] = [];
  for (let index = 0; index < sampleSize; index += 1) {
    const shared = rng();
    left.push(sharedLoading * shared + residualLoading * rng());
    right.push(sharedLoading * shared + residualLoading * rng());
  }

  const observed = samplePearsonCorrelation(left, right);
  if (!Number.isFinite(observed) || Math.abs(observed - correlation) > absoluteTolerance) {
    throw new Error(
      `generated pairwise Metric correlation ${observed} is outside tolerance ${absoluteTolerance} of declared ${correlation}.`,
    );
  }
  return observed;
}

function samplePearsonCorrelation(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length || left.length < 2) {
    throw new Error(
      "Pearson correlation requires two equal-length series with at least two observations.",
    );
  }

  const n = left.length;
  const leftMean = meanOf(left);
  const rightMean = meanOf(right);

  let cross = 0;
  let leftSq = 0;
  let rightSq = 0;
  for (let index = 0; index < n; index += 1) {
    const leftDelta = requiredSeriesValue(left, index) - leftMean;
    const rightDelta = requiredSeriesValue(right, index) - rightMean;
    cross += leftDelta * rightDelta;
    leftSq += leftDelta * leftDelta;
    rightSq += rightDelta * rightDelta;
  }

  if (leftSq === 0 || rightSq === 0) {
    throw new Error("Pearson correlation is undefined for a zero-variance series.");
  }
  return cross / Math.sqrt(leftSq * rightSq);
}

function meanOf(values: readonly number[]): number {
  let sum = 0;
  for (let index = 0; index < values.length; index += 1) {
    sum += requiredSeriesValue(values, index);
  }
  return sum / values.length;
}

function requiredSeriesValue(values: readonly number[], index: number): number {
  const value = values[index];
  if (value === undefined) {
    throw new Error(`Pearson correlation missing observation at index ${index}.`);
  }
  return value;
}
