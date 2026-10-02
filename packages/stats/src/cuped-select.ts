import { type CupedAttributeSource, cupedAttributeSources } from "@splitch/contracts";
import { finiteValue } from "./variance-math";
import type { CupedCovariateRow, EntityAggregate } from "./variance-estimator-types";

const ATTRIBUTE_SOURCE_RANK: Readonly<Record<CupedAttributeSource, number>> = {
  declared: 0,
  pre_period_selected: 1,
  historical_selected: 2,
};

export interface CupedCandidate {
  readonly method: "pre_period" | "attribute_covariate";
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

export function prePeriodCandidate(
  metricId: string,
  arms: readonly (readonly EntityAggregate[])[],
  covariates: readonly CupedCovariateRow[],
): CupedCandidate {
  const values = new Map<string, number>();
  for (const row of covariates) {
    if (row.covariate_source === "pre_period" && row.metric_id === metricId) {
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

/**
 * Rank locked attribute candidates without reading outcomes. Order is source
 * (declared, then pre-period selected, then historical), then higher min-arm
 * coverage, then attribute name. Coverage is an eligibility gate first; it is
 * only a rank key among candidates that already clear the threshold.
 */
export function selectAttributeCandidate(
  arms: readonly (readonly EntityAggregate[])[],
  covariates: readonly CupedCovariateRow[],
  thresholdPct: number,
): CupedCandidate | null {
  const eligible = eligibleAttributeGroups(covariates)
    .map((group) => attributeCandidate(group, arms))
    .filter((candidate) => candidate.coveragePct >= thresholdPct)
    .sort(compareAttributeCandidates);

  return eligible.find((candidate) => isFitCapable(candidate, arms)) ?? null;
}

export function isFitCapable(
  candidate: CupedCandidate,
  arms: readonly (readonly EntityAggregate[])[],
): boolean {
  return arms.some((entities, index) => {
    const values = candidate.armValues[index];
    if (values === undefined) {
      throw new Error("CUPED candidate is missing covariate values for an arm.");
    }
    const xs: number[] = [];
    for (const entity of entities) {
      const value = values.get(entity.targeting_key_hash);
      if (value !== undefined) {
        xs.push(value);
      }
    }
    // Exact variation, not a variance cutoff: an absolute threshold would make
    // a covariate's eligibility depend on its units.
    return xs.length >= 2 && xs.some((x) => x !== xs[0]);
  });
}

function compareAttributeCandidates(left: CupedCandidate, right: CupedCandidate): number {
  const sourceDelta = sourceRank(left.attributeSource) - sourceRank(right.attributeSource);
  if (sourceDelta !== 0) {
    return sourceDelta;
  }
  if (left.coveragePct !== right.coveragePct) {
    return right.coveragePct - left.coveragePct;
  }
  return (left.attribute ?? "").localeCompare(right.attribute ?? "");
}

function sourceRank(source: CupedAttributeSource | null): number {
  if (source === null) {
    throw new Error("attribute CUPED candidates require an attribute_source.");
  }
  const rank = ATTRIBUTE_SOURCE_RANK[source];
  if (rank === undefined) {
    throw new Error(`unknown CUPED attribute_source ${source}.`);
  }
  return rank;
}

function attributeCandidate(
  group: AttributeGroup,
  arms: readonly (readonly EntityAggregate[])[],
): CupedCandidate {
  return {
    method: "attribute_covariate",
    attribute: group.attribute,
    attributeSource: group.source,
    armValues: arms.map((entities) => valuesForArm(entities, group.values)),
    coveragePct: minCoveragePct(arms, group.values),
  };
}

function eligibleAttributeGroups(covariates: readonly CupedCovariateRow[]): AttributeGroup[] {
  const groups = new Map<string, { source: CupedAttributeSource; values: Map<string, number> }>();

  for (const row of covariates) {
    if (!row.attribute || row.locked !== true) {
      continue;
    }

    const source = attributeSourceFor(row);
    const group = groups.get(row.attribute) ?? { source, values: new Map<string, number>() };
    if (group.source !== source) {
      // Rank is by source, so mixed provenance would make the choice depend on row order.
      throw new Error(
        `CUPED attribute ${row.attribute} has conflicting attribute_source values (${group.source}, ${source}).`,
      );
    }
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
  if (row.covariate_source === "declared_attribute") {
    return "declared";
  }
  throw new Error(
    `CUPED attribute ${row.attribute} is missing a recognized attribute_source (${cupedAttributeSources.join(", ")}).`,
  );
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
