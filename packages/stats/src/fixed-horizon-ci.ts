import { inverseNormalCdf, normalCdf } from "./normal-distribution";
import type { CIAdapter, CIError, CIParams, CIResult, CISource, CIWarning } from "./sequential-ci";

export const FIXED_HORIZON_CI_SOURCE: CISource = {
  family: "fixed-horizon-two-sample-z-test",
  references: [
    "docs/spec/stats/sequential-testing-mechanics.md#fixed-horizon-stopping-opt-in",
    "docs/adr/0014-stats-engine-sequential-always-valid-frequentist-by-default.md",
  ],
};

export class FixedHorizonCI implements CIAdapter {
  compute(params: CIParams): CIResult {
    const inputError = validateParams(params);
    if (inputError) {
      return errorResult(params, inputError);
    }

    const sampleSizeLocked = params.sample_size_locked;
    if (sampleSizeLocked === undefined) {
      return errorResult(params, {
        code: "FIXED_HORIZON_LOCK_MISSING",
        message: "FixedHorizonCI requires sample_size_locked from the locked Run input.",
      });
    }

    if (params.n_t !== sampleSizeLocked || params.n_c !== sampleSizeLocked) {
      return infiniteResult(params, "warning", [
        {
          code: "FIXED_HORIZON_NOT_AT_LOCKED_SAMPLE",
          message: "FixedHorizonCI is decision-valid only at sample_size_locked in both arms.",
        },
      ]);
    }

    if (params.sampling_var === 0) {
      return infiniteResult(params, "warning", [
        {
          code: "ZERO_SAMPLING_VARIANCE",
          message: "sampling_var=0 cannot support a finite decision-valid interval.",
        },
      ]);
    }

    const standardError = Math.sqrt(params.sampling_var);
    const criticalValue = inverseNormalCdf(1 - params.alpha / 2);
    const boundary = criticalValue * standardError;

    if (!Number.isFinite(boundary) || boundary < 0) {
      return errorResult(params, {
        code: "NUMERICAL_OVERFLOW",
        message: "FixedHorizonCI boundary overflowed before producing a finite interval.",
      });
    }

    const ciLower = params.estimate - boundary;
    const ciUpper = params.estimate + boundary;
    const pValue = fixedHorizonPValue(params.estimate, standardError);

    if (!isStableResult(ciLower, ciUpper, pValue, params.estimate, boundary)) {
      return errorResult(params, {
        code: "NUMERICAL_OVERFLOW",
        message: "FixedHorizonCI produced a numerically unstable interval or p-value.",
      });
    }

    return {
      ci_lower: ciLower,
      ci_upper: ciUpper,
      p_value: pValue,
      mode: "fixed",
      status: "ok",
      source: FIXED_HORIZON_CI_SOURCE,
      n: params.n_t + params.n_c,
      peeking_allowed: false,
      sample_size_locked: sampleSizeLocked,
      boundary,
      critical_value: criticalValue,
    };
  }
}

export function computeFixedHorizonCI(params: CIParams): CIResult {
  return new FixedHorizonCI().compute(params);
}

export function fixedHorizonPValue(estimate: number, standardError: number): number {
  if (standardError === 0) {
    return 1;
  }

  const z = Math.abs(estimate / standardError);
  return Math.max(0, Math.min(1, 2 * (1 - normalCdf(z))));
}

function validateParams(params: CIParams): CIError | undefined {
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
  if (
    params.sample_size_locked !== undefined &&
    (!Number.isSafeInteger(params.sample_size_locked) || params.sample_size_locked <= 0)
  ) {
    return {
      code: "INVALID_INPUT",
      message: "sample_size_locked must be a positive safe integer.",
    };
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
  status: "warning" | "error",
  warnings: readonly CIWarning[] = [],
  error?: CIError,
): CIResult {
  return {
    ci_lower: Number.NEGATIVE_INFINITY,
    ci_upper: Number.POSITIVE_INFINITY,
    p_value: 1,
    mode: "fixed",
    status,
    source: FIXED_HORIZON_CI_SOURCE,
    n: params.n_t + params.n_c,
    peeking_allowed: false,
    sample_size_locked: params.sample_size_locked,
    boundary: Number.POSITIVE_INFINITY,
    warnings,
    error,
  };
}

function errorResult(params: CIParams, error: CIError): CIResult {
  return infiniteResult(params, "error", [], error);
}
