import {
  type CupedAttributeSource,
  DEFAULT_CUPED_COVERAGE_THRESHOLD_PCT,
} from "@splitch/contracts";
import { type CupedArm, adjustCupedArms } from "./cuped-fit";
import { finiteValue, sampleVariance } from "./variance-math";
import type {
  CupedAdjustment,
  CupedCovariateRow,
  EntityAggregate,
  MetricComparisonEstimateInput,
} from "./variance-estimator-types";

const MIN_VARIANCE_REDUCTION = 1e-12;

interface CupedCandidate {
  readonly method: CupedAdjustment["method"];
  readonly attribute: string | null;
  readonly attributeSource: CupedAttributeSource | null;
  /** Covariate values per arm, positionally aligned with the arms under fit. */
  readonly armValues: readonly ReadonlyMap<string, number>[];
  readonly coveragePct: number;
}

interface AttributeGroup {
  readonly attribute: string;
  readonly source: CupedAttributeSource;
  readonly values: Map<string, number>;
}

type RuntimeCupedCovariateRow = Omit<CupedCovariateRow, "covariate_source"> & {
  readonly covariate_source?: string;
};

/**
 * Select and apply one CUPED adjustment across every arm of the Run.
 *
 * `arms` is Control first, then each Treatment. Selection (coverage, attribute
 * choice) and the fit itself span all arms, so the adjustment a Run publishes
 * for any one arm does not depend on which other arms it is compared against.
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

  const prePeriod = prePeriodCandidate(input, arms, covariates);
  if (prePeriod.coveragePct >= thresholdPct) {
    return adjustmentForCandidate(prePeriod, arms);
  }

  const attribute = bestAttributeCandidate(arms, covariates, thresholdPct);
  if (attribute) {
    return adjustmentForCandidate(attribute, arms);
  }

  return none(arms, prePeriod.coveragePct);
}

function prePeriodCandidate(
  input: Pick<MetricComparisonEstimateInput, "metric_id">,
  arms: readonly (readonly EntityAggregate[])[],
  covariates: readonly CupedCovariateRow[],
): CupedCandidate {
  const values = new Map<string, number>();
  for (const row of covariates) {
    if (row.covariate_source === "pre_period" && row.metric_id === input.metric_id) {
      values.set(row.targeting_key_hash, finiteValue(row.pre_period_value, "pre_period_value"));
    }
  }

  return {
    method: "pre_period",
    attribute: null,
    attributeSource: null,
    armValues: arms.map((entities) => valuesForArm(entities, values)),
    coveragePct: minCoveragePct(arms, values),
  };
}

function bestAttributeCandidate(
  arms: readonly (readonly EntityAggregate[])[],
  covariates: readonly CupedCovariateRow[],
  thresholdPct: number,
): CupedCandidate | null {
  let best: { candidate: CupedCandidate; score: number } | null = null;

  for (const group of eligibleAttributeGroups(covariates)) {
    const candidate: CupedCandidate = {
      method: "attribute_covariate",
      attribute: group.attribute,
      attributeSource: group.source,
      armValues: arms.map((entities) => valuesForArm(entities, group.values)),
      coveragePct: minCoveragePct(arms, group.values),
    };

    if (candidate.coveragePct < thresholdPct) {
      continue;
    }

    const score = varianceReductionScore(candidate, arms);
    if (score > MIN_VARIANCE_REDUCTION && (!best || score > best.score)) {
      best = { candidate, score };
    }
  }

  return best?.candidate ?? null;
}

function eligibleAttributeGroups(covariates: readonly CupedCovariateRow[]): AttributeGroup[] {
  const groups = new Map<string, { source: CupedAttributeSource; values: Map<string, number> }>();

  for (const row of covariates) {
    if (!row.attribute || row.locked !== true) {
      continue;
    }

    const source = attributeSourceFor(row);
    const group = groups.get(row.attribute) ?? { source, values: new Map<string, number>() };
    group.values.set(row.targeting_key_hash, finiteValue(row.pre_period_value, "pre_period_value"));
    groups.set(row.attribute, group);
  }

  return [...groups.entries()].map(([attribute, group]) => ({
    attribute,
    source: group.source,
    values: group.values,
  }));
}

function attributeSourceFor(row: CupedCovariateRow): CupedAttributeSource {
  if (row.attribute_source) {
    return row.attribute_source;
  }
  if (row.covariate_source === "pre_period") {
    return "pre_period_selected";
  }
  if (row.covariate_source === "historical_attribute") {
    return "historical_selected";
  }
  return "declared";
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
  };
}

function varianceReductionScore(
  candidate: CupedCandidate,
  arms: readonly (readonly EntityAggregate[])[],
): number {
  const rawVariance = totalSamplingVariance(arms);
  const adjustedVariance = totalSamplingVariance(adjustCupedArms(cupedArmsFor(candidate, arms)));
  return rawVariance - adjustedVariance;
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

function totalSamplingVariance(arms: readonly (readonly EntityAggregate[])[]): number {
  return arms.reduce((total, entities) => total + armSamplingVariance(entities), 0);
}

function armSamplingVariance(entities: readonly EntityAggregate[]): number {
  return entities.length === 0
    ? 0
    : sampleVariance(entities.map((entity) => entity.value)) / entities.length;
}

function valuesForArm(
  entities: readonly EntityAggregate[],
  values: ReadonlyMap<string, number>,
): ReadonlyMap<string, number> {
  const armValues = new Map<string, number>();
  for (const entity of entities) {
    const value = values.get(entity.targeting_key_hash);
    if (value !== undefined) {
      armValues.set(entity.targeting_key_hash, value);
    }
  }
  return armValues;
}

/** The weakest arm gates the adjustment: one uncovered arm makes the fit unusable. */
function minCoveragePct(
  arms: readonly (readonly EntityAggregate[])[],
  values: ReadonlyMap<string, number>,
): number {
  if (arms.length === 0) {
    return 0;
  }
  return Math.min(...arms.map((entities) => coveragePct(entities, values)));
}

function coveragePct(
  entities: readonly EntityAggregate[],
  values: ReadonlyMap<string, number>,
): number {
  if (entities.length === 0) {
    return 0;
  }
  const covered = entities.filter((entity) => values.has(entity.targeting_key_hash)).length;
  return (covered / entities.length) * 100;
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
