import type {
  ActivationRow,
  DedupeExposureRow,
  HealthMetrics,
  SrmResult,
} from "@splitch/contracts";
import type { SrmProcedure } from "./analysis-version-policy";
import {
  activatedExposureRows,
  dedupedExposureRowsForVariant,
  MULTIPLE_VARIANT,
} from "./exposure-denominator";
import {
  chiSquareActivationBalance,
  chiSquareAgainstAllocation,
  type SrmTestInternalResult,
} from "./srm-checker-chi-square";
import { resolveSrmProcedure, sequentialSrmAlongEntityPath } from "./srm-checker-sequential";
import type { SrmPathEntity } from "./srm-observation-path";
import { expectedCountsForOutput, safeRate, sumCounts, zeroCounts } from "./srm-counts";
import { SRM_MISMATCH_P_VALUE } from "./srm-checker-threshold";
import {
  activationRowsByEntityForRun,
  earliestValidActivationIngestTs,
  exposuresByEntityForRun,
} from "./srm-activated-arrival";

export { SRM_MISMATCH_P_VALUE };

export interface SrmCheckerInput {
  readonly run_id: string;
  readonly allocation: Readonly<Record<string, number>>;
  readonly exposures: readonly DedupeExposureRow[];
  readonly activation_rows?: readonly ActivationRow[];
  readonly has_activation_gate?: boolean;
  /** Defaults to chi_square (analysis-v1 / legacy). analysis-v2 selects sequential_martingale. */
  readonly srm_procedure?: SrmProcedure;
}

export interface SrmCheckerOutput {
  readonly srm: SrmResult;
  readonly health: HealthMetrics;
}

export function checkSrmHealth(input: SrmCheckerInput): SrmCheckerOutput {
  const variants = allocationVariants(input.allocation);
  assertExposureVariantsAreDeclared(input, variants);
  const procedure = resolveSrmProcedure(input.srm_procedure);

  const dedupedEntities = dedupedPathEntities(input, variants);
  const dedupedCounts = countsFromPathEntities(dedupedEntities, variants);
  const fullSrm = srmAgainstPopulation(
    dedupedCounts,
    dedupedEntities,
    input.allocation,
    variants,
    procedure,
  );
  const activation = activationDiagnostics(input, variants, dedupedCounts, procedure);
  const multipleCount = multipleEntityCount(input);

  return {
    srm: {
      srm_p_value: fullSrm.p_value,
      srm_is_mismatch: fullSrm.is_mismatch,
      observed_counts: dedupedCounts,
      expected_counts: expectedCountsForOutput(
        sumCounts(dedupedCounts),
        input.allocation,
        variants,
      ),
      activated_srm_p_value: activation.activatedSrm?.p_value ?? null,
      activated_srm_mismatch: activation.activatedSrm?.is_mismatch ?? null,
    },
    health: {
      multiple_rate: safeRate(multipleCount, sumCounts(dedupedCounts) + multipleCount),
      multiple_count: multipleCount,
      activation_rates: activation.activationRates,
      activation_balance_p_value: activation.activationBalance?.p_value ?? null,
      activation_balance_mismatch: activation.activationBalance?.is_mismatch ?? null,
      exposure_counts: exposureCountsByVariant(input, variants),
      deduped_counts: dedupedCounts,
      low_n_warning: variants.some((variant) => (dedupedCounts[variant] ?? 0) < 100),
    },
  };
}

/**
 * Activation balance stays chi-square under every analysis version: it tests
 * equality of unknown rates, not the declared allocation multinomial (plan 0.6).
 */
function activationDiagnostics(
  input: SrmCheckerInput,
  variants: readonly string[],
  dedupedCounts: Readonly<Record<string, number>>,
  procedure: SrmProcedure,
): {
  readonly activatedSrm: SrmTestInternalResult | null;
  readonly activationBalance: SrmTestInternalResult | null;
  readonly activationRates: Record<string, number> | null;
} {
  const hasActivationGate = input.has_activation_gate ?? input.activation_rows !== undefined;
  if (!hasActivationGate) {
    return { activatedSrm: null, activationBalance: null, activationRates: null };
  }

  const activatedEntities = activatedPathEntities(input, variants);
  const activatedCounts = countsFromPathEntities(activatedEntities, variants);
  return {
    activatedSrm: activationGuardrail(
      activatedCounts,
      () =>
        srmAgainstPopulation(
          activatedCounts,
          activatedEntities,
          input.allocation,
          variants,
          procedure,
        ),
      variants,
    ),
    activationBalance: activationGuardrail(
      activatedCounts,
      () => chiSquareActivationBalance(activatedCounts, dedupedCounts, variants),
      variants,
    ),
    activationRates: Object.fromEntries(
      variants.map((variant) => [
        variant,
        safeRate(activatedCounts[variant] ?? 0, dedupedCounts[variant] ?? 0),
      ]),
    ),
  };
}

function activationGuardrail(
  activatedCounts: Readonly<Record<string, number>>,
  calculate: () => SrmTestInternalResult,
  variants: readonly string[],
): SrmTestInternalResult {
  if (variants.every((variant) => (activatedCounts[variant] ?? 0) === 0)) {
    return { p_value: 0, is_mismatch: true, chi2_stat: 0 };
  }
  return calculate();
}

function allocationVariants(allocation: Readonly<Record<string, number>>): string[] {
  const variants = Object.keys(allocation);
  if (variants.length < 2) {
    throw new Error("SRM allocation requires at least two variants.");
  }

  const total = variants.reduce((sum, variant) => {
    const weight = allocation[variant];
    if (weight === undefined || !Number.isFinite(weight) || weight <= 0) {
      throw new Error(`SRM allocation for ${variant} must be positive.`);
    }
    return sum + weight;
  }, 0);

  if (!Number.isFinite(total) || total <= 0) {
    throw new Error("SRM allocation total must be positive.");
  }

  return variants;
}

function assertExposureVariantsAreDeclared(
  input: SrmCheckerInput,
  variants: readonly string[],
): void {
  const declared = new Set(variants);
  for (const exposure of input.exposures) {
    if (
      exposure.run_id === input.run_id &&
      exposure.variant !== MULTIPLE_VARIANT &&
      !declared.has(exposure.variant)
    ) {
      throw new Error(`SRM exposure variant ${exposure.variant} is missing from allocation.`);
    }
  }
}

function dedupedPathEntities(input: SrmCheckerInput, variants: readonly string[]): SrmPathEntity[] {
  return variants.flatMap((variant) =>
    dedupedExposureRowsForVariant({ ...input, variant }).map((exposure) => {
      if (exposure.first_ingest_ts === undefined || exposure.first_ingest_ts === "") {
        throw new Error(
          `first_ingest_ts is required for analysis-v2 SRM entity ${exposure.targeting_key_hash}.`,
        );
      }
      return {
        targeting_key_hash: exposure.targeting_key_hash,
        variant: exposure.variant,
        arrival_ts: exposure.first_ingest_ts,
      };
    }),
  );
}

function activatedPathEntities(
  input: SrmCheckerInput,
  variants: readonly string[],
): SrmPathEntity[] {
  const activationRows = input.activation_rows ?? [];
  const activationsByEntity = activationRowsByEntityForRun(input.run_id, activationRows);
  const exposuresByEntity = exposuresByEntityForRun(input.run_id, input.exposures);
  const declared = new Set(variants);
  const path: SrmPathEntity[] = [];
  for (const exposure of activatedExposureRows({
    run_id: input.run_id,
    exposures: input.exposures,
    activation_rows: activationRows,
  })) {
    if (!declared.has(exposure.variant)) {
      continue;
    }
    path.push({
      targeting_key_hash: exposure.targeting_key_hash,
      variant: exposure.variant,
      arrival_ts: earliestValidActivationIngestTs(
        exposuresByEntity.get(exposure.targeting_key_hash) ?? [exposure],
        activationsByEntity.get(exposure.targeting_key_hash) ?? [],
      ),
    });
  }
  return path;
}

function countsFromPathEntities(
  entities: readonly SrmPathEntity[],
  variants: readonly string[],
): Record<string, number> {
  const counts = zeroCounts(variants);
  for (const entity of entities) {
    counts[entity.variant] = (counts[entity.variant] ?? 0) + 1;
  }
  return counts;
}

function exposureCountsByVariant(
  input: SrmCheckerInput,
  variants: readonly string[],
): Record<string, number> {
  const counts = zeroCounts(variants);
  for (const exposure of input.exposures) {
    if (exposure.run_id === input.run_id && exposure.variant !== MULTIPLE_VARIANT) {
      counts[exposure.variant] = (counts[exposure.variant] ?? 0) + 1;
    }
  }
  return counts;
}

function multipleEntityCount(input: SrmCheckerInput): number {
  const entities = new Set<string>();
  for (const exposure of input.exposures) {
    if (exposure.run_id === input.run_id && exposure.variant === MULTIPLE_VARIANT) {
      entities.add(exposure.targeting_key_hash);
    }
  }
  return entities.size;
}

function srmAgainstPopulation(
  observed: Readonly<Record<string, number>>,
  entities: SrmPathEntity[],
  allocation: Readonly<Record<string, number>>,
  variants: readonly string[],
  procedure: SrmProcedure,
): SrmTestInternalResult {
  if (procedure === "sequential_martingale") {
    const sequential = sequentialSrmAlongEntityPath(entities, allocation);
    return { ...sequential, chi2_stat: 0 };
  }
  return chiSquareAgainstAllocation(observed, allocation, variants);
}
