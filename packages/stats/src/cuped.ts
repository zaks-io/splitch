import {
  type CupedAttributeSource,
  DEFAULT_CUPED_COVERAGE_THRESHOLD_PCT,
} from "@splitch/contracts";
import { adjustCupedArms } from "./cuped-fit";
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
  readonly controlValues: ReadonlyMap<string, number>;
  readonly treatmentValues: ReadonlyMap<string, number>;
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

export function applyCupedAdjustment(
  input: MetricComparisonEstimateInput,
  controlEntities: readonly EntityAggregate[],
  treatmentEntities: readonly EntityAggregate[],
): CupedAdjustment {
  if (input.cuped === false || input.metric_type === "ratio") {
    return none(controlEntities, treatmentEntities, null);
  }

  const thresholdPct = cupedCoverageThresholdPct(input.cuped_coverage_threshold);
  const covariates = input.pre_period_covariates ?? [];
  validateCovariates(covariates, [...controlEntities, ...treatmentEntities]);

  const prePeriod = prePeriodCandidate(input, controlEntities, treatmentEntities, covariates);
  if (prePeriod.coveragePct >= thresholdPct) {
    return adjustmentForCandidate(prePeriod, controlEntities, treatmentEntities);
  }

  const attribute = bestAttributeCandidate(
    controlEntities,
    treatmentEntities,
    covariates,
    thresholdPct,
  );
  if (attribute) {
    return adjustmentForCandidate(attribute, controlEntities, treatmentEntities);
  }

  return none(controlEntities, treatmentEntities, prePeriod.coveragePct);
}

function prePeriodCandidate(
  input: Pick<MetricComparisonEstimateInput, "metric_id">,
  controlEntities: readonly EntityAggregate[],
  treatmentEntities: readonly EntityAggregate[],
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
    controlValues: valuesForArm(controlEntities, values),
    treatmentValues: valuesForArm(treatmentEntities, values),
    coveragePct: minCoveragePct(controlEntities, treatmentEntities, values),
  };
}

function bestAttributeCandidate(
  controlEntities: readonly EntityAggregate[],
  treatmentEntities: readonly EntityAggregate[],
  covariates: readonly CupedCovariateRow[],
  thresholdPct: number,
): CupedCandidate | null {
  let best: { candidate: CupedCandidate; score: number } | null = null;

  for (const group of eligibleAttributeGroups(covariates)) {
    const candidate: CupedCandidate = {
      method: "attribute_covariate",
      attribute: group.attribute,
      attributeSource: group.source,
      controlValues: valuesForArm(controlEntities, group.values),
      treatmentValues: valuesForArm(treatmentEntities, group.values),
      coveragePct: minCoveragePct(controlEntities, treatmentEntities, group.values),
    };

    if (candidate.coveragePct < thresholdPct) {
      continue;
    }

    const score = varianceReductionScore(candidate, controlEntities, treatmentEntities);
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
  controlEntities: readonly EntityAggregate[],
  treatmentEntities: readonly EntityAggregate[],
): CupedAdjustment {
  const adjusted = adjustCupedArms(
    controlEntities,
    candidate.controlValues,
    treatmentEntities,
    candidate.treatmentValues,
  );

  return {
    controlEntities: adjusted.control,
    treatmentEntities: adjusted.treatment,
    method: candidate.method,
    attribute: candidate.attribute,
    attributeSource: candidate.attributeSource,
    coveragePct: candidate.coveragePct,
  };
}

function varianceReductionScore(
  candidate: CupedCandidate,
  controlEntities: readonly EntityAggregate[],
  treatmentEntities: readonly EntityAggregate[],
): number {
  const rawVariance = armSamplingVariance(controlEntities) + armSamplingVariance(treatmentEntities);
  const adjusted = adjustCupedArms(
    controlEntities,
    candidate.controlValues,
    treatmentEntities,
    candidate.treatmentValues,
  );
  const adjustedVariance =
    armSamplingVariance(adjusted.control) + armSamplingVariance(adjusted.treatment);
  return rawVariance - adjustedVariance;
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

function minCoveragePct(
  controlEntities: readonly EntityAggregate[],
  treatmentEntities: readonly EntityAggregate[],
  values: ReadonlyMap<string, number>,
): number {
  return Math.min(coveragePct(controlEntities, values), coveragePct(treatmentEntities, values));
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
  controlEntities: readonly EntityAggregate[],
  treatmentEntities: readonly EntityAggregate[],
  coveragePct: number | null,
): CupedAdjustment {
  return {
    controlEntities,
    treatmentEntities,
    method: "none",
    attribute: null,
    attributeSource: null,
    coveragePct,
  };
}

function cupedCoverageThresholdPct(value: number | undefined): number {
  const threshold = value ?? DEFAULT_CUPED_COVERAGE_THRESHOLD_PCT;
  const pct = threshold > 0 && threshold < 1 ? threshold * 100 : threshold;
  if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
    throw new Error("cuped_coverage_threshold must be > 0 and <= 100.");
  }
  return pct;
}
