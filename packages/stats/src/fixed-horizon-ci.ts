import { inverseNormalCdf, normalCdf, normalSurvival } from "./normal-distribution";
import {
  type CIAdapter,
  type CIError,
  type CIParams,
  type CIResult,
  type CISource,
  type CIWarning,
  infiniteCIResult,
  isStableCIResult,
  validateCIParams,
} from "./confidence-interval";

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

    // Callers truncate each arm to `sample_size_locked` Entities before
    // estimating, so a shortfall here means the Run has not reached its horizon
    // yet. An over-count means the caller skipped that truncation and is asking
    // for a fixed-horizon decision on a sample the Run never pre-registered.
    if (params.n_t !== sampleSizeLocked || params.n_c !== sampleSizeLocked) {
      return infiniteResult(params, "warning", [
        {
          code: "FIXED_HORIZON_NOT_AT_LOCKED_SAMPLE",
          message: `FixedHorizonCI decides at ${sampleSizeLocked} Entities per arm; Control has ${params.n_c} and Treatment has ${params.n_t}.`,
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

    if (!isStableCIResult(ciLower, ciUpper, pValue, params.estimate, boundary)) {
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
  const directUpperTail = 1 - normalCdf(z);
  if (directUpperTail > 0) {
    return Math.min(1, 2 * directUpperTail);
  }
  return Math.max(Number.MIN_VALUE, Math.min(1, 2 * normalSurvival(z)));
}

function validateParams(params: CIParams): CIError | undefined {
  const commonError = validateCIParams(params);
  if (commonError) return commonError;
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

function infiniteResult(
  params: CIParams,
  status: "warning" | "error",
  warnings: readonly CIWarning[] = [],
  error?: CIError,
): CIResult {
  return infiniteCIResult(
    params,
    {
      mode: "fixed",
      source: FIXED_HORIZON_CI_SOURCE,
      sampleSizeLocked: params.sample_size_locked,
    },
    { status, warnings, error },
  );
}

function errorResult(params: CIParams, error: CIError): CIResult {
  return infiniteResult(params, "error", [], error);
}
