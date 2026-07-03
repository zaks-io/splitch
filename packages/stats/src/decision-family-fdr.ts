import type { ArmResult, DecisionFamilyMember } from "@splitch/contracts";

type DecisionFamilyKeyFields = Pick<DecisionFamilyMember, "metric_id" | "variant"> &
  Partial<Pick<DecisionFamilyMember, "dimension_id" | "dimension_value">>;

export type DecisionFamilyArmResult = ArmResult & DecisionFamilyKeyFields;

export interface DecisionFamilyCorrectionInput<Result extends DecisionFamilyArmResult> {
  readonly arm_results: readonly Result[];
  readonly decision_family: readonly DecisionFamilyMember[];
  readonly confidence_level: number;
  readonly control_variant?: string;
}

export interface DecisionFamilyCorrectionSummary {
  readonly alpha: number;
  readonly family_size_m: number;
  readonly rejected: readonly DecisionFamilyMember[];
}

export interface DecisionFamilyCorrectionOutput<Result extends DecisionFamilyArmResult> {
  readonly arm_results: Result[];
  readonly summary: DecisionFamilyCorrectionSummary;
}

interface RankedFamilyMember<Result extends DecisionFamilyArmResult> {
  readonly key: string;
  readonly member: DecisionFamilyMember;
  readonly result: Result;
}

export function applyDecisionFamilyCorrection<Result extends DecisionFamilyArmResult>(
  input: DecisionFamilyCorrectionInput<Result>,
): DecisionFamilyCorrectionOutput<Result> {
  const alpha = alphaFromConfidenceLevel(input.confidence_level);
  const familyByKey = decisionFamilyByKey(input.decision_family);

  validatePValues(input.arm_results);

  if (familyByKey.size === 0) {
    return {
      arm_results: input.arm_results.map((result) => markExploratoryRaw(result, alpha)),
      summary: {
        alpha,
        family_size_m: 0,
        rejected: [],
      },
    };
  }

  const resultByKey = lockedResultsByKey(input.arm_results, familyByKey);
  const ranked = rankDecisionFamilyMembers(familyByKey, resultByKey);
  const rejectedKeys = rejectedDecisionKeys(ranked, familyByKey.size, alpha);

  return {
    arm_results: input.arm_results.map((result) => {
      const key = decisionFamilyKey(result);
      if (!familyByKey.has(key)) {
        if (isLockedControlResult(result, input.control_variant, familyByKey)) {
          return markLockedControl(result);
        }
        return markExploratoryRaw(result, alpha);
      }

      return {
        ...result,
        is_significant: rejectedKeys.has(key),
        in_bh_family: true,
        exploratory: false,
        decision_valid: true,
      };
    }),
    summary: {
      alpha,
      family_size_m: familyByKey.size,
      rejected: ranked.filter((entry) => rejectedKeys.has(entry.key)).map((entry) => entry.member),
    },
  };
}

function alphaFromConfidenceLevel(confidenceLevel: number): number {
  if (!Number.isFinite(confidenceLevel) || confidenceLevel <= 0 || confidenceLevel >= 1) {
    throw new Error("confidence_level must be finite and in (0, 1).");
  }
  return Number((1 - confidenceLevel).toPrecision(15));
}

function decisionFamilyByKey(
  decisionFamily: readonly DecisionFamilyMember[],
): Map<string, DecisionFamilyMember> {
  const byKey = new Map<string, DecisionFamilyMember>();
  for (const member of decisionFamily) {
    validateDimensionPair(member);
    const key = decisionFamilyKey(member);
    if (byKey.has(key)) {
      throw new Error(`decision_family contains duplicate member ${key}.`);
    }
    byKey.set(key, member);
  }
  return byKey;
}

function validatePValues(results: readonly DecisionFamilyArmResult[]): void {
  for (const result of results) {
    if (!Number.isFinite(result.p_value) || result.p_value < 0 || result.p_value > 1) {
      throw new Error(`p_value for ${result.metric_id}/${result.variant} must be in [0, 1].`);
    }
  }
}

function lockedResultsByKey<Result extends DecisionFamilyArmResult>(
  results: readonly Result[],
  familyByKey: ReadonlyMap<string, DecisionFamilyMember>,
): Map<string, Result> {
  const resultByKey = new Map<string, Result>();

  for (const result of results) {
    validateDimensionPair(result);
    const key = decisionFamilyKey(result);
    if (!familyByKey.has(key)) {
      continue;
    }
    if (resultByKey.has(key)) {
      throw new Error(`arm_results contains duplicate decision_family member ${key}.`);
    }
    resultByKey.set(key, result);
  }

  return resultByKey;
}

function rankDecisionFamilyMembers<Result extends DecisionFamilyArmResult>(
  familyByKey: ReadonlyMap<string, DecisionFamilyMember>,
  resultByKey: ReadonlyMap<string, Result>,
): RankedFamilyMember<Result>[] {
  const ranked: RankedFamilyMember<Result>[] = [];

  for (const [key, member] of familyByKey) {
    const result = resultByKey.get(key);
    if (result === undefined) {
      throw new Error(`arm_results is missing locked decision_family member ${key}.`);
    }
    ranked.push({ key, member, result });
  }

  return ranked.sort(
    (left, right) =>
      left.result.p_value - right.result.p_value || left.key.localeCompare(right.key),
  );
}

function rejectedDecisionKeys<Result extends DecisionFamilyArmResult>(
  ranked: readonly RankedFamilyMember<Result>[],
  familySize: number,
  alpha: number,
): Set<string> {
  let maxRejectedRank = 0;

  for (let index = 0; index < ranked.length; index += 1) {
    const rank = index + 1;
    const threshold = (rank / familySize) * alpha;
    const entry = ranked[index];
    if (entry !== undefined && entry.result.p_value <= threshold) {
      maxRejectedRank = rank;
    }
  }

  return new Set(ranked.slice(0, maxRejectedRank).map((entry) => entry.key));
}

function markExploratoryRaw<Result extends DecisionFamilyArmResult>(
  result: Result,
  alpha: number,
): Result {
  return {
    ...result,
    is_significant: result.p_value < alpha,
    in_bh_family: false,
    exploratory: true,
    decision_valid: false,
  };
}

function markLockedControl<Result extends DecisionFamilyArmResult>(result: Result): Result {
  return {
    ...result,
    is_significant: false,
    in_bh_family: false,
    exploratory: false,
    decision_valid: true,
  };
}

function isLockedControlResult<Result extends DecisionFamilyArmResult>(
  result: Result,
  controlVariant: string | undefined,
  familyByKey: ReadonlyMap<string, DecisionFamilyMember>,
): boolean {
  if (controlVariant === undefined || result.variant !== controlVariant) {
    return false;
  }

  for (const member of familyByKey.values()) {
    if (isSameMetricSlice(result, member)) {
      return true;
    }
  }

  return false;
}

function isSameMetricSlice(result: DecisionFamilyKeyFields, member: DecisionFamilyMember): boolean {
  return (
    result.metric_id === member.metric_id &&
    (result.dimension_id ?? null) === (member.dimension_id ?? null) &&
    (result.dimension_value ?? null) === (member.dimension_value ?? null)
  );
}

function validateDimensionPair(member: DecisionFamilyKeyFields): void {
  const hasDimensionId = member.dimension_id !== undefined && member.dimension_id !== null;
  const hasDimensionValue = member.dimension_value !== undefined && member.dimension_value !== null;
  if (hasDimensionId !== hasDimensionValue) {
    throw new Error("decision_family dimension_id and dimension_value must be provided together.");
  }
}

function decisionFamilyKey(member: DecisionFamilyKeyFields): string {
  return JSON.stringify([
    member.metric_id,
    member.variant,
    member.dimension_id ?? null,
    member.dimension_value ?? null,
  ]);
}
