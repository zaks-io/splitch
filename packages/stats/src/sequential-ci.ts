export interface CIAdapter {
  compute(params: CIParams): CIResult;
}

export interface CIParams {
  readonly estimate: number;
  readonly sampling_var: number;
  readonly n_t: number;
  readonly n_c: number;
  readonly alpha: number;
  readonly target_n?: number;
  readonly sample_size_locked?: number;
}

export type CIStatus = "ok" | "warning" | "error";

export interface CIWarning {
  readonly code:
    | "ZERO_SAMPLING_VARIANCE"
    | "INSUFFICIENT_SAMPLE"
    | "FIXED_HORIZON_NOT_AT_LOCKED_SAMPLE";
  readonly message: string;
}

export interface CIError {
  readonly code: "INVALID_INPUT" | "NUMERICAL_OVERFLOW" | "FIXED_HORIZON_LOCK_MISSING";
  readonly message: string;
}

export interface CISource {
  readonly family:
    | "normal-mixture-asymptotic-confidence-sequence"
    | "fixed-horizon-two-sample-z-test";
  readonly references: readonly string[];
}

export interface CIResult {
  readonly ci_lower: number;
  readonly ci_upper: number;
  readonly p_value: number;
  readonly mode: "sequential" | "fixed";
  readonly status: CIStatus;
  readonly source: CISource;
  readonly n: number;
  readonly peeking_allowed: boolean;
  readonly target_n?: number;
  readonly sample_size_locked?: number;
  readonly rho_squared?: number;
  readonly boundary: number;
  readonly critical_value?: number;
  readonly warnings?: readonly CIWarning[];
  readonly error?: CIError;
}

export interface SequentialCIOptions {
  readonly defaultTargetN?: number;
}

export const SEQUENTIAL_CI_SOURCE: CISource = {
  family: "normal-mixture-asymptotic-confidence-sequence",
  references: [
    "https://arxiv.org/abs/1810.08240",
    "https://arxiv.org/abs/2103.06476",
    "https://arxiv.org/abs/2302.10108",
  ],
};

const DEFAULT_TARGET_N = 5_000;
const ROOT_SOLVER_ITERATIONS = 80;

export class SequentialCI implements CIAdapter {
  readonly #defaultTargetN: number;

  constructor(options: SequentialCIOptions = {}) {
    this.#defaultTargetN = options.defaultTargetN ?? DEFAULT_TARGET_N;
  }

  compute(params: CIParams): CIResult {
    const targetN = params.target_n ?? this.#defaultTargetN;
    const inputError = validateParams(params, targetN);
    if (inputError) {
      return errorResult(params, targetN, inputError);
    }

    const n = params.n_t + params.n_c;
    const rhoSquared = rhoSquaredForTargetN(params.alpha, targetN);
    const warnings: CIWarning[] = [];

    if (params.n_t === 0 || params.n_c === 0) {
      warnings.push({
        code: "INSUFFICIENT_SAMPLE",
        message: "SequentialCI needs at least one deduped Exposure in each arm.",
      });
    }

    if (params.sampling_var === 0) {
      warnings.push({
        code: "ZERO_SAMPLING_VARIANCE",
        message: "sampling_var=0 cannot support a finite decision-valid interval.",
      });
    }

    if (warnings.length > 0) {
      return infiniteResult(params, targetN, rhoSquared, "warning", warnings);
    }

    const standardError = Math.sqrt(params.sampling_var);
    const scale = normalMixtureScale(n, params.alpha, rhoSquared);
    const boundary = standardError * scale;

    if (!Number.isFinite(boundary) || boundary < 0) {
      return errorResult(params, targetN, {
        code: "NUMERICAL_OVERFLOW",
        message: "SequentialCI boundary overflowed before producing a finite interval.",
      });
    }

    const ciLower = params.estimate - boundary;
    const ciUpper = params.estimate + boundary;
    const pValue = normalMixturePValue(Math.abs(params.estimate), standardError, n, targetN);

    if (!isStableResult(ciLower, ciUpper, pValue, params.estimate, boundary)) {
      return errorResult(params, targetN, {
        code: "NUMERICAL_OVERFLOW",
        message: "SequentialCI produced a numerically unstable interval or p-value.",
      });
    }

    return {
      ci_lower: ciLower,
      ci_upper: ciUpper,
      p_value: pValue,
      mode: "sequential",
      status: "ok",
      source: SEQUENTIAL_CI_SOURCE,
      n,
      peeking_allowed: true,
      target_n: targetN,
      rho_squared: rhoSquared,
      boundary,
    };
  }
}

export const computeSequentialCI = (params: CIParams): CIResult =>
  new SequentialCI().compute(params);

export function rhoSquaredForTargetN(alpha: number, targetN: number): number {
  return solveOptimalNormalMixtureInformation(alpha) / targetN;
}

export function normalMixtureScale(n: number, alpha: number, rhoSquared: number): number {
  const informationRatio = n * rhoSquared;
  const logTerm = Math.log(Math.sqrt(1 + informationRatio) / alpha);
  return Math.sqrt((2 * (1 + informationRatio) * logTerm) / informationRatio);
}

function normalMixturePValue(
  absEstimate: number,
  standardError: number,
  n: number,
  targetN: number,
): number {
  if (absEstimate === 0) {
    return 1;
  }

  let low = Number.MIN_VALUE;
  let high = 1 - Number.EPSILON;

  if (normalMixtureBoundary(n, high, targetN, standardError) >= absEstimate) {
    return 1;
  }

  for (let index = 0; index < ROOT_SOLVER_ITERATIONS; index += 1) {
    const mid = (low + high) / 2;
    if (normalMixtureBoundary(n, mid, targetN, standardError) < absEstimate) {
      high = mid;
    } else {
      low = mid;
    }
  }

  return high;
}

function normalMixtureBoundary(
  n: number,
  alpha: number,
  targetN: number,
  standardError: number,
): number {
  return standardError * normalMixtureScale(n, alpha, rhoSquaredForTargetN(alpha, targetN));
}

function solveOptimalNormalMixtureInformation(alpha: number): number {
  const target = 2 * Math.log(1 / alpha);
  let low = Number.EPSILON;
  let high = Math.max(2, target + Math.log1p(target) + 2);

  while (normalMixtureOptimumEquation(high, target) < 0) {
    high *= 2;
  }

  for (let index = 0; index < ROOT_SOLVER_ITERATIONS; index += 1) {
    const mid = (low + high) / 2;
    if (normalMixtureOptimumEquation(mid, target) < 0) {
      low = mid;
    } else {
      high = mid;
    }
  }

  return (low + high) / 2;
}

function normalMixtureOptimumEquation(informationRatio: number, target: number): number {
  return informationRatio - Math.log1p(informationRatio) - target;
}

function validateParams(params: CIParams, targetN: number): CIError | undefined {
  if (!Number.isFinite(params.estimate)) {
    return { code: "INVALID_INPUT", message: "estimate must be finite." };
  }
  if (!Number.isFinite(params.sampling_var) || params.sampling_var < 0) {
    return { code: "INVALID_INPUT", message: "sampling_var must be finite and non-negative." };
  }
  if (!isCount(params.n_t) || !isCount(params.n_c)) {
    return { code: "INVALID_INPUT", message: "n_t and n_c must be non-negative safe integers." };
  }
  if (!Number.isFinite(params.alpha) || params.alpha <= 0 || params.alpha >= 1) {
    return { code: "INVALID_INPUT", message: "alpha must be finite and in (0, 1)." };
  }
  if (!Number.isFinite(targetN) || targetN <= 0) {
    return { code: "INVALID_INPUT", message: "target_n must be finite and positive." };
  }

  return undefined;
}

function isCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isStableResult(
  ciLower: number,
  ciUpper: number,
  pValue: number,
  estimate: number,
  boundary: number,
): boolean {
  return (
    Number.isFinite(ciLower) &&
    Number.isFinite(ciUpper) &&
    (boundary === 0 ? ciLower <= estimate : ciLower < estimate) &&
    (boundary === 0 ? estimate <= ciUpper : estimate < ciUpper) &&
    Number.isFinite(pValue) &&
    pValue >= 0 &&
    pValue <= 1
  );
}

function infiniteResult(
  params: CIParams,
  targetN: number,
  rhoSquared: number,
  status: "warning" | "error",
  warnings: readonly CIWarning[] = [],
  error?: CIError,
): CIResult {
  return {
    ci_lower: Number.NEGATIVE_INFINITY,
    ci_upper: Number.POSITIVE_INFINITY,
    p_value: 1,
    mode: "sequential",
    status,
    source: SEQUENTIAL_CI_SOURCE,
    n: params.n_t + params.n_c,
    peeking_allowed: true,
    target_n: targetN,
    rho_squared: rhoSquared,
    boundary: Number.POSITIVE_INFINITY,
    warnings,
    error,
  };
}

function errorResult(params: CIParams, targetN: number, error: CIError): CIResult {
  const rhoSquared =
    Number.isFinite(params.alpha) &&
    params.alpha > 0 &&
    params.alpha < 1 &&
    Number.isFinite(targetN) &&
    targetN > 0
      ? rhoSquaredForTargetN(params.alpha, targetN)
      : Number.NaN;

  return infiniteResult(params, targetN, rhoSquared, "error", [], error);
}
