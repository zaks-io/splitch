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

type InfiniteResultMetadata =
  | {
      readonly mode: "sequential";
      readonly source: CISource;
      readonly targetN: number;
      readonly rhoSquared: number;
    }
  | {
      readonly mode: "fixed";
      readonly source: CISource;
      readonly sampleSizeLocked: number | undefined;
    };

interface InfiniteResultOutcome {
  readonly status: "warning" | "error";
  readonly warnings?: readonly CIWarning[];
  readonly error?: CIError;
}

export function validateCIParams(params: CIParams): CIError | undefined {
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
  return undefined;
}

export function isStableCIResult(
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

export function infiniteCIResult(
  params: CIParams,
  metadata: InfiniteResultMetadata,
  outcome: InfiniteResultOutcome,
): CIResult {
  const common = {
    ci_lower: Number.NEGATIVE_INFINITY,
    ci_upper: Number.POSITIVE_INFINITY,
    p_value: 1,
    status: outcome.status,
    source: metadata.source,
    n: params.n_t + params.n_c,
    boundary: Number.POSITIVE_INFINITY,
    warnings: outcome.warnings ?? [],
    error: outcome.error,
  };
  return metadata.mode === "sequential"
    ? {
        ...common,
        mode: metadata.mode,
        peeking_allowed: true,
        target_n: metadata.targetN,
        rho_squared: metadata.rhoSquared,
      }
    : {
        ...common,
        mode: metadata.mode,
        peeking_allowed: false,
        sample_size_locked: metadata.sampleSizeLocked,
      };
}

function isCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
