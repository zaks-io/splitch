export function chiSquareUpperTail(chi2Stat: number, degreesOfFreedom: number): number {
  if (degreesOfFreedom <= 0 || chi2Stat <= 0) {
    return 1;
  }

  return regularizedGammaQ(degreesOfFreedom / 2, chi2Stat / 2);
}

function regularizedGammaQ(shape: number, x: number): number {
  if (shape <= 0 || x < 0) {
    throw new Error("gamma inputs are outside their domain.");
  }
  if (x === 0) {
    return 1;
  }
  if (x < shape + 1) {
    return clampProbability(1 - gammaSeriesP(shape, x));
  }
  return clampProbability(gammaContinuedFractionQ(shape, x));
}

function gammaSeriesP(shape: number, x: number): number {
  const maxIterations = 100;
  const epsilon = 1e-14;
  let sum = 1 / shape;
  let term = sum;

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    term *= x / (shape + iteration);
    sum += term;
    if (Math.abs(term) < Math.abs(sum) * epsilon) {
      break;
    }
  }

  return sum * Math.exp(-x + shape * Math.log(x) - logGamma(shape));
}

function gammaContinuedFractionQ(shape: number, x: number): number {
  const maxIterations = 100;
  const epsilon = 1e-14;
  const tiny = 1e-300;
  let b = x + 1 - shape;
  let c = 1 / tiny;
  let d = 1 / Math.max(b, tiny);
  let h = d;

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    const an = -iteration * (iteration - shape);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) {
      d = tiny;
    }
    c = b + an / c;
    if (Math.abs(c) < tiny) {
      c = tiny;
    }
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < epsilon) {
      break;
    }
  }

  return Math.exp(-x + shape * Math.log(x) - logGamma(shape)) * h;
}

function logGamma(value: number): number {
  const coefficients = [
    676.5203681218851, -1259.1392167224028, 771.3234287776531, -176.6150291621406,
    12.507343278686905, -0.13857109526572012, 9.984369578019572e-6, 1.5056327351493116e-7,
  ];

  if (value < 0.5) {
    return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * value)) - logGamma(1 - value);
  }

  let x = 0.9999999999998099;
  const shifted = value - 1;
  for (let index = 0; index < coefficients.length; index += 1) {
    x += (coefficients[index] ?? 0) / (shifted + index + 1);
  }

  const t = shifted + coefficients.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(t) - t + Math.log(x);
}

function clampProbability(value: number): number {
  if (value < 0 && value > -1e-12) {
    return 0;
  }
  if (value > 1 && value < 1 + 1e-12) {
    return 1;
  }
  return value;
}
