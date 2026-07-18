const INVERSE_LOW_BREAKPOINT = 0.02425;
const INVERSE_HIGH_BREAKPOINT = 1 - INVERSE_LOW_BREAKPOINT;

export function normalCdf(value: number): number {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const coefficients = [0.254829592, -0.284496736, 1.421413741, -1.453152027, 1.061405429];
  const polynomial = coefficients.reduceRight((acc, coefficient) => (acc + coefficient) * t, 0);
  const erf = sign * (1 - polynomial * Math.exp(-x * x));
  return 0.5 * (1 + erf);
}

export function normalSurvival(value: number): number {
  if (value < 0) {
    return normalCdf(-value);
  }

  const x = value / Math.SQRT2;
  const t = 1 / (1 + 0.5 * x);
  let polynomial = 0.17087277;
  for (const coefficient of [
    -0.82215223, 1.48851587, -1.13520398, 0.27886807, -0.18628806, 0.09678418, 0.37409196,
    1.00002368,
  ]) {
    polynomial = coefficient + t * polynomial;
  }
  const erfc = t * Math.exp(-x * x - 1.26551223 + t * polynomial);
  return Math.max(0, Math.min(0.5, erfc / 2));
}

export function inverseNormalCdf(probability: number): number {
  if (!Number.isFinite(probability) || probability <= 0 || probability >= 1) {
    throw new Error("probability must be finite and in (0, 1).");
  }

  if (probability < INVERSE_LOW_BREAKPOINT) {
    const q = Math.sqrt(-2 * Math.log(probability));
    return rationalApproximation(q, LOW_NUMERATOR, LOW_DENOMINATOR);
  }

  if (probability > INVERSE_HIGH_BREAKPOINT) {
    const q = Math.sqrt(-2 * Math.log(1 - probability));
    return -rationalApproximation(q, LOW_NUMERATOR, LOW_DENOMINATOR);
  }

  const q = probability - 0.5;
  const r = q * q;
  return (q * polynomial(CENTER_NUMERATOR, r)) / polynomialWithTrailingOne(CENTER_DENOMINATOR, r);
}

function rationalApproximation(
  value: number,
  numerator: readonly number[],
  denominator: readonly number[],
): number {
  return polynomial(numerator, value) / polynomialWithTrailingOne(denominator, value);
}

function polynomial(coefficients: readonly number[], value: number): number {
  return coefficients.reduce((acc, coefficient) => acc * value + coefficient, 0);
}

function polynomialWithTrailingOne(coefficients: readonly number[], value: number): number {
  return coefficients.reduce((acc, coefficient) => acc * value + coefficient, 0) * value + 1;
}

const CENTER_NUMERATOR = [
  -39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716,
  2.506628277459239,
] as const;

const CENTER_DENOMINATOR = [
  -54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572,
] as const;

const LOW_NUMERATOR = [
  -0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734,
  4.374664141464968, 2.938163982698783,
] as const;

const LOW_DENOMINATOR = [
  0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416,
] as const;
