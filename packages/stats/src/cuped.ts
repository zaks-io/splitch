import { DEFAULT_CUPED_COVERAGE_THRESHOLD_PCT } from "@splitch/contracts";
import { type CupedArm, adjustCupedArms } from "./cuped-fit";
import {
  type CupedCandidate,
  isFitCapable,
  prePeriodCandidate,
  selectAttributeCandidate,
} from "./cuped-select";
import { finiteValue } from "./variance-math";
import type {
  CupedAdjustment,
  CupedCovariateRow,
  EntityAggregate,
  MetricComparisonEstimateInput,
} from "./variance-estimator-types";

type RuntimeCupedCovariateRow = Omit<CupedCovariateRow, "covariate_source"> & {
  readonly covariate_source?: string;
};

/**
 * Select and apply one CUPED adjustment across every arm of the Run.
 *
 * `arms` is Control first, then each Treatment. Selection (coverage, attribute
 * choice) and the fit itself span all arms, so the adjustment a Run publishes
 * for any one arm does not depend on which other arms it is compared against.
 *
 * Selection reads only locked covariate values and declared configuration. It
 * never scores candidates on current outcomes. Theta is still refit on the
 * current sample; that is coefficient estimation, not covariate choice.
 */
export function applyCupedAdjustment(
  input: Omit<MetricComparisonEstimateInput, "treatment_variant">,
  arms: readonly (readonly EntityAggregate[])[],
): CupedAdjustment {
  if (input.cuped === false || input.metric_type === "ratio") {
    return none(arms, null);
  }

  const thresholdPct = cupedCoverageThresholdPct(input.cuped_coverage_threshold_pct);
  const covariates = input.pre_period_covariates ?? [];
  validateCovariates(covariates, arms.flat());

  const prePeriod = prePeriodCandidate(input.metric_id, arms, covariates);
  if (prePeriod.coveragePct >= thresholdPct && isFitCapable(prePeriod, arms)) {
    return adjustmentForCandidate(prePeriod, arms);
  }

  const attribute = selectAttributeCandidate(arms, covariates, thresholdPct);
  if (attribute) {
    return adjustmentForCandidate(attribute, arms);
  }

  return none(arms, prePeriod.coveragePct);
}

function adjustmentForCandidate(
  candidate: CupedCandidate,
  arms: readonly (readonly EntityAggregate[])[],
): CupedAdjustment {
  return {
    arms: adjustCupedArms(cupedArmsFor(candidate, arms)),
    method: candidate.method,
    attribute: candidate.attribute,
    attributeSource: candidate.attributeSource,
    coveragePct: candidate.coveragePct,
    covariates: candidate.armValues,
  };
}

function cupedArmsFor(
  candidate: CupedCandidate,
  arms: readonly (readonly EntityAggregate[])[],
): CupedArm[] {
  return arms.map((entities, index) => {
    const values = candidate.armValues[index];
    if (values === undefined) {
      throw new Error("CUPED candidate is missing covariate values for an arm.");
    }
    return { entities, values };
  });
}

function validateCovariates(
  covariates: readonly CupedCovariateRow[],
  entities: readonly EntityAggregate[],
): void {
  const firstExposureByEntity = new Map(
    entities.map((entity) => [entity.targeting_key_hash, entity.first_exposure_ts]),
  );

  for (const row of covariates) {
    if ((row as RuntimeCupedCovariateRow).covariate_source === "post_treatment") {
      throw new Error("post-treatment CUPED covariates are not eligible.");
    }
    finiteValue(row.pre_period_value, "pre_period_value");
    const firstExposureTs = firstExposureByEntity.get(row.targeting_key_hash);
    if (!firstExposureTs || !row.observed_at) {
      continue;
    }
    if (Date.parse(row.observed_at) >= Date.parse(firstExposureTs)) {
      throw new Error(
        `CUPED covariate ${row.metric_id} for ${row.targeting_key_hash} must be before first_exposure_ts.`,
      );
    }
  }
}

function none(
  arms: readonly (readonly EntityAggregate[])[],
  coveragePct: number | null,
): CupedAdjustment {
  return {
    arms,
    method: "none",
    attribute: null,
    attributeSource: null,
    coveragePct,
    covariates: null,
  };
}

// Percent, never a fraction. A previous version rescaled values under 1 as if
// they were fractions, which silently turned a legal 0.5 ("half a percent
// coverage") into 50 and decided whether CUPED ran at all on a 100x error.
function cupedCoverageThresholdPct(value: number | undefined): number {
  const pct = value ?? DEFAULT_CUPED_COVERAGE_THRESHOLD_PCT;
  if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
    throw new Error("cuped_coverage_threshold_pct must be a percent > 0 and <= 100.");
  }
  return pct;
}
