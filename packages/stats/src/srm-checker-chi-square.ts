import { chiSquareUpperTail } from "./chi-square";
import { SRM_MISMATCH_P_VALUE } from "./srm-checker-threshold";

export interface SrmTestInternalResult {
  readonly p_value: number;
  readonly is_mismatch: boolean;
  readonly chi2_stat: number;
}

export function chiSquareAgainstAllocation(
  observed: Readonly<Record<string, number>>,
  allocation: Readonly<Record<string, number>>,
  variants: readonly string[],
): SrmTestInternalResult {
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

export function chiSquareActivationBalance(
  activatedCounts: Readonly<Record<string, number>>,
  exposedCounts: Readonly<Record<string, number>>,
  variants: readonly string[],
): SrmTestInternalResult {
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
