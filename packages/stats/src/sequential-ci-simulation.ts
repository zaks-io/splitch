import type { CIAdapter } from "./sequential-ci.js";

export interface RepeatedLookSimulationConfig {
  readonly adapter: CIAdapter;
  readonly method: "sequential" | "fixed-horizon";
  readonly alpha: number;
  readonly seed: string;
  readonly iterations: number;
  readonly lookSchedule: readonly number[];
  readonly target_n?: number;
}

export interface RepeatedLookSimulationResult {
  readonly method: "sequential" | "fixed-horizon";
  readonly seed: string;
  readonly iterations: number;
  readonly rejections: number;
  readonly rejectionRate: number;
  readonly alpha: number;
  readonly lookSchedule: readonly number[];
}

export function runRepeatedLookSimulation(
  config: RepeatedLookSimulationConfig,
): RepeatedLookSimulationResult {
  const rng = seededNormal(config.seed);
  let rejections = 0;

  for (let iteration = 0; iteration < config.iterations; iteration += 1) {
    if (runOneNullExperiment(config, rng)) {
      rejections += 1;
    }
  }

  return {
    method: config.method,
    seed: config.seed,
    iterations: config.iterations,
    rejections,
    rejectionRate: rejections / config.iterations,
    alpha: config.alpha,
    lookSchedule: config.lookSchedule,
  };
}

function runOneNullExperiment(config: RepeatedLookSimulationConfig, rng: () => number): boolean {
  const treatment = new RunningStats();
  const control = new RunningStats();
  const maxLook = Math.max(...config.lookSchedule);
  let lookIndex = 0;

  for (let sample = 1; sample <= maxLook; sample += 1) {
    treatment.push(rng());
    control.push(rng());

    if (sample !== config.lookSchedule[lookIndex]) {
      continue;
    }
    if (pValueAtLook(config, treatment, control) <= config.alpha) {
      return true;
    }

    lookIndex += 1;
    if (lookIndex >= config.lookSchedule.length) {
      return false;
    }
  }

  return false;
}

function pValueAtLook(
  config: RepeatedLookSimulationConfig,
  treatment: RunningStats,
  control: RunningStats,
): number {
  const samplingVar = treatment.variance / treatment.count + control.variance / control.count;
  const estimate = treatment.mean - control.mean;

  if (config.method === "fixed-horizon") {
    return fixedHorizonPValue(estimate, Math.sqrt(samplingVar));
  }

  return config.adapter.compute({
    estimate,
    sampling_var: samplingVar,
    n_t: treatment.count,
    n_c: control.count,
    alpha: config.alpha,
    target_n: config.target_n,
  }).p_value;
}

export function monteCarloTolerance(alpha: number, iterations: number): number {
  return Math.max(0.02, 3 * Math.sqrt((alpha * (1 - alpha)) / iterations));
}

export function meetsAlwaysValidBound(
  result: RepeatedLookSimulationResult,
  tolerance: number,
): boolean {
  return result.rejectionRate <= result.alpha + tolerance;
}

class RunningStats {
  count = 0;
  mean = 0;
  #m2 = 0;

  get variance(): number {
    return this.count > 1 ? this.#m2 / (this.count - 1) : 0;
  }

  push(value: number): void {
    this.count += 1;
    const delta = value - this.mean;
    this.mean += delta / this.count;
    this.#m2 += delta * (value - this.mean);
  }
}

function fixedHorizonPValue(estimate: number, standardError: number): number {
  if (standardError === 0) {
    return 1;
  }

  const z = Math.abs(estimate / standardError);
  return Math.max(0, Math.min(1, 2 * (1 - normalCdf(z))));
}

function normalCdf(value: number): number {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const coefficients = [0.254829592, -0.284496736, 1.421413741, -1.453152027, 1.061405429];
  const polynomial = coefficients.reduceRight((acc, coefficient) => (acc + coefficient) * t, 0);
  const erf = sign * (1 - polynomial * Math.exp(-x * x));
  return 0.5 * (1 + erf);
}

function seededNormal(seed: string): () => number {
  const uniform = mulberry32(fnv1a(seed));
  let spare: number | undefined;

  return () => {
    if (spare !== undefined) {
      const value = spare;
      spare = undefined;
      return value;
    }

    const first = Math.max(Number.MIN_VALUE, uniform());
    const second = uniform();
    const radius = Math.sqrt(-2 * Math.log(first));
    const angle = 2 * Math.PI * second;
    spare = radius * Math.sin(angle);
    return radius * Math.cos(angle);
  };
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let next = state;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
