import type {
  ActivationRow,
  DedupeExposureRow,
  HealthMetrics,
  SrmResult,
} from "@splitch/contracts";
import { chiSquareUpperTail } from "./chi-square.js";
import { dedupedExposureRowsForVariant, MULTIPLE_VARIANT } from "./exposure-denominator.js";
import { expectedCountsForOutput, safeRate, sumCounts, zeroCounts } from "./srm-counts.js";

export const SRM_MISMATCH_P_VALUE = 0.001;

export interface SrmCheckerInput {
  readonly run_id: string;
  readonly allocation: Readonly<Record<string, number>>;
  readonly exposures: readonly DedupeExposureRow[];
  readonly activation_rows?: readonly ActivationRow[];
  readonly has_activation_gate?: boolean;
}

export interface SrmCheckerOutput {
  readonly srm: SrmResult;
  readonly health: HealthMetrics;
}

interface InternalChiSquareResult {
  readonly p_value: number;
  readonly is_mismatch: boolean;
  readonly chi2_stat: number;
}

export function checkSrmHealth(input: SrmCheckerInput): SrmCheckerOutput {
  const variants = allocationVariants(input.allocation);
  assertExposureVariantsAreDeclared(input, variants);

  const dedupedCounts = dedupedCountsByVariant(input, variants);
  const fullSrm = chiSquareAgainstAllocation(dedupedCounts, input.allocation, variants);
  const hasActivationGate = input.has_activation_gate ?? input.activation_rows !== undefined;
  const activatedCounts = hasActivationGate ? activatedCountsByVariant(input, variants) : null;
  const activatedSrm =
    activatedCounts === null
      ? null
      : chiSquareAgainstAllocation(activatedCounts, input.allocation, variants);
  const activationBalance =
    activatedCounts === null
      ? null
      : chiSquareActivationBalance(activatedCounts, dedupedCounts, variants);
  const activationRates =
    activatedCounts === null
      ? null
      : Object.fromEntries(
          variants.map((variant) => [
            variant,
            safeRate(activatedCounts[variant] ?? 0, dedupedCounts[variant] ?? 0),
          ]),
        );
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
      activated_srm_p_value: activatedSrm?.p_value ?? null,
      activated_srm_mismatch: activatedSrm?.is_mismatch ?? null,
    },
    health: {
      multiple_rate: safeRate(multipleCount, sumCounts(dedupedCounts) + multipleCount),
      multiple_count: multipleCount,
      activation_rates: activationRates,
      activation_balance_p_value: activationBalance?.p_value ?? null,
      activation_balance_mismatch: activationBalance?.is_mismatch ?? null,
      exposure_counts: exposureCountsByVariant(input, variants),
      deduped_counts: dedupedCounts,
      low_n_warning: variants.some((variant) => (dedupedCounts[variant] ?? 0) < 100),
    },
  };
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

function dedupedCountsByVariant(
  input: SrmCheckerInput,
  variants: readonly string[],
): Record<string, number> {
  return Object.fromEntries(
    variants.map((variant) => [
      variant,
      dedupedExposureRowsForVariant({ ...input, variant }).length,
    ]),
  );
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

function activatedCountsByVariant(
  input: SrmCheckerInput,
  variants: readonly string[],
): Record<string, number> {
  const counts = zeroCounts(variants);
  const activationRows = input.activation_rows ?? [];
  const activationsByEntity = activationRowsByEntity(input.run_id, activationRows);

  for (const variant of variants) {
    for (const exposure of dedupedExposureRowsForVariant({ ...input, variant })) {
      if (isActivatedAfterExposure(exposure, activationsByEntity)) {
        counts[variant] = (counts[variant] ?? 0) + 1;
      }
    }
  }

  return counts;
}

function activationRowsByEntity(
  runId: string,
  rows: readonly ActivationRow[],
): Map<string, ActivationRow[]> {
  const byEntity = new Map<string, ActivationRow[]>();
  for (const row of rows) {
    if (row.run_id !== runId || !row.activated) {
      continue;
    }

    const existing = byEntity.get(row.targeting_key_hash) ?? [];
    existing.push(row);
    byEntity.set(row.targeting_key_hash, existing);
  }
  return byEntity;
}

function isActivatedAfterExposure(
  exposure: DedupeExposureRow,
  activationsByEntity: ReadonlyMap<string, readonly ActivationRow[]>,
): boolean {
  const activations = activationsByEntity.get(exposure.targeting_key_hash) ?? [];
  return activations.some(
    (activation) =>
      timestampMs(activation.activation_ts, "activation_ts") >
      timestampMs(exposure.first_exposure_ts, "first_exposure_ts"),
  );
}

function chiSquareAgainstAllocation(
  observed: Readonly<Record<string, number>>,
  allocation: Readonly<Record<string, number>>,
  variants: readonly string[],
): InternalChiSquareResult {
  const totalObserved = variants.reduce((sum, variant) => sum + (observed[variant] ?? 0), 0);
  if (totalObserved === 0) {
    return { p_value: 1, is_mismatch: false, chi2_stat: 0 };
  }

  const allocationTotal = variants.reduce((sum, variant) => sum + (allocation[variant] ?? 0), 0);
  let chi2Stat = 0;
  for (const variant of variants) {
    const expected = (totalObserved * (allocation[variant] ?? 0)) / allocationTotal;
    if (expected <= 0) {
      throw new Error(`SRM expected count for ${variant} must be positive.`);
    }
    const delta = (observed[variant] ?? 0) - expected;
    chi2Stat += delta ** 2 / expected;
  }

  const pValue = chiSquareUpperTail(chi2Stat, variants.length - 1);
  return {
    p_value: pValue,
    is_mismatch: pValue < SRM_MISMATCH_P_VALUE,
    chi2_stat: chi2Stat,
  };
}

function chiSquareActivationBalance(
  activatedCounts: Readonly<Record<string, number>>,
  exposedCounts: Readonly<Record<string, number>>,
  variants: readonly string[],
): InternalChiSquareResult {
  const rows: Array<readonly [number, number]> = variants.map((variant) => {
    const activated = activatedCounts[variant] ?? 0;
    const exposed = exposedCounts[variant] ?? 0;
    return [activated, Math.max(0, exposed - activated)];
  });
  const rowTotals = rows.map((row) => row[0] + row[1]);
  const columnTotals = [
    rows.reduce((sum, row) => sum + row[0], 0),
    rows.reduce((sum, row) => sum + row[1], 0),
  ];
  const total = rowTotals.reduce((sum, value) => sum + value, 0);
  if (total === 0) {
    return { p_value: 1, is_mismatch: false, chi2_stat: 0 };
  }

  let chi2Stat = 0;
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    const rowTotal = rowTotals[rowIndex] ?? 0;
    for (let columnIndex = 0; columnIndex < columnTotals.length; columnIndex += 1) {
      const observed = row?.[columnIndex] ?? 0;
      const expected = (rowTotal * (columnTotals[columnIndex] ?? 0)) / total;
      if (expected > 0) {
        chi2Stat += (observed - expected) ** 2 / expected;
      }
    }
  }

  const pValue = chiSquareUpperTail(chi2Stat, variants.length - 1);
  return {
    p_value: pValue,
    is_mismatch: pValue < SRM_MISMATCH_P_VALUE,
    chi2_stat: chi2Stat,
  };
}

function timestampMs(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${field} must be an ISO timestamp.`);
  }
  return parsed;
}
