export function finiteValue(value: number | undefined, field: string): number {
  if (value === undefined || !Number.isFinite(value)) {
    throw new Error(`${field} must be finite.`);
  }
  return value;
}

export function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function sampleVariance(values: readonly number[]): number {
  if (values.length < 2) {
    return 0;
  }

  const center = mean(values);
  return values.reduce((sum, value) => sum + (value - center) ** 2, 0) / (values.length - 1);
}

export function sampleCovariance(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length) {
    throw new Error("covariance inputs must have the same length.");
  }
  if (left.length < 2) {
    return 0;
  }

  const leftMean = mean(left);
  const rightMean = mean(right);
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index];
    const rightValue = right[index];
    if (leftValue === undefined || rightValue === undefined) {
      throw new Error("covariance inputs must have the same length.");
    }
    sum += (leftValue - leftMean) * (rightValue - rightMean);
  }
  return sum / (left.length - 1);
}

export function clampSamplingVariance(value: number): number {
  if (value < 0 && value > -1e-12) {
    return 0;
  }
  return value;
}
