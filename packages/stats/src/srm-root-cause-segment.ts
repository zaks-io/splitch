/**
 * Segment localization helpers for the Fabijan SRM root-cause classifier.
 * Localization requires a chi-square homogeneity rejection across slice
 * proportions — threshold crossings alone are not enough.
 */

import { chiSquareUpperTail } from "./chi-square";
import {
  SRM_ROOT_CAUSE_NEXT_CHECK,
  SRM_ROOT_CAUSE_SEGMENT_HOMOGENEITY_ALPHA,
  type SrmRootCauseMatchedBranch,
  type SrmRootCauseSegmentCut,
} from "./srm-root-cause-types";

export function segmentLocalizedMatch(
  cuts: readonly SrmRootCauseSegmentCut[] | undefined,
): SrmRootCauseMatchedBranch | null {
  if (cuts === undefined) {
    return null;
  }
  const mismatched = cuts.filter((cut) => cut.srmIsMismatch);
  // Localized means some slices carry the imbalance and others do not.
  if (mismatched.length === 0 || mismatched.length === cuts.length) {
    return null;
  }
  // Without per-slice counts we cannot tell volume-driven significance from
  // true proportion differences — do not claim localization.
  if (cuts.some((cut) => cut.observedCounts === undefined)) {
    return null;
  }
  const homogeneity = sliceHomogeneity(cuts);
  if (homogeneity === null || homogeneity.pValue >= SRM_ROOT_CAUSE_SEGMENT_HOMOGENEITY_ALPHA) {
    return null;
  }
  const sample = mismatched[0];
  if (sample === undefined) {
    throw new Error("SRM root-cause mismatched segment list was empty after a non-empty filter.");
  }
  const label =
    mismatched.length === 1
      ? `${sample.dimensionId}=${sample.dimensionValue}`
      : `${mismatched.length} Dimension slices`;
  return {
    branch: "segment_localized",
    explanation: `SRM is concentrated in ${label} while other requested slices remain balanced (slice-proportion homogeneity p=${formatP(homogeneity.pValue)} < ${SRM_ROOT_CAUSE_SEGMENT_HOMOGENEITY_ALPHA}).`,
    nextCheck: SRM_ROOT_CAUSE_NEXT_CHECK,
  };
}

/**
 * Proper-subset threshold crossings whose slice proportions do not differ
 * beyond noise — report crossings, do not claim localization.
 */
export function segmentThresholdCrossingsWithoutLocalization(
  cuts: readonly SrmRootCauseSegmentCut[] | undefined,
): { explanation: string; evidenceTag: string } | null {
  if (cuts === undefined) {
    return null;
  }
  const mismatched = cuts.filter((cut) => cut.srmIsMismatch);
  if (mismatched.length === 0 || mismatched.length === cuts.length) {
    return null;
  }
  const labels = mismatched.map((cut) => `${cut.dimensionId}=${cut.dimensionValue}`);
  const crossed = labels.join(", ");
  if (cuts.some((cut) => cut.observedCounts === undefined)) {
    return {
      explanation: `SRM threshold crossed in ${crossed}; slice arm counts are absent, so localization is not claimed.`,
      evidenceTag: `segment_threshold_crossed:${labels.join("|")};localization:counts_absent`,
    };
  }
  const homogeneity = sliceHomogeneity(cuts);
  if (homogeneity === null) {
    return {
      explanation: `SRM threshold crossed in ${crossed}; slice counts are not comparable across Variants, so localization is not claimed.`,
      evidenceTag: `segment_threshold_crossed:${labels.join("|")};localization:counts_incomparable`,
    };
  }
  if (homogeneity.pValue < SRM_ROOT_CAUSE_SEGMENT_HOMOGENEITY_ALPHA) {
    // Homogeneity rejected — segmentLocalizedMatch should have matched instead.
    return null;
  }
  return {
    explanation: `SRM threshold crossed in ${crossed}; slice imbalances do not differ beyond noise (homogeneity p=${formatP(homogeneity.pValue)} ≥ ${SRM_ROOT_CAUSE_SEGMENT_HOMOGENEITY_ALPHA}), so localization is not claimed.`,
    evidenceTag: `segment_threshold_crossed:${labels.join("|")};segment_homogeneity:p=${formatP(homogeneity.pValue)}_alpha=${SRM_ROOT_CAUSE_SEGMENT_HOMOGENEITY_ALPHA}_not_localized`,
  };
}

function sliceHomogeneity(
  cuts: readonly SrmRootCauseSegmentCut[],
): { pValue: number; chi2Stat: number } | null {
  const table = contingencyTable(cuts);
  if (table === null) {
    return null;
  }
  const { rows, rowTotals, columnTotals, total, variantCount } = table;
  const chi2Stat = contingencyChi2(rows, rowTotals, columnTotals, total);
  const degreesOfFreedom = (rows.length - 1) * (variantCount - 1);
  return { pValue: chiSquareUpperTail(chi2Stat, degreesOfFreedom), chi2Stat };
}

function contingencyTable(cuts: readonly SrmRootCauseSegmentCut[]): {
  rows: number[][];
  rowTotals: number[];
  columnTotals: number[];
  total: number;
  variantCount: number;
} | null {
  const variants = variantUniverse(cuts);
  if (variants === null || variants.length < 2 || cuts.length < 2) {
    return null;
  }
  const rows: number[][] = [];
  for (const cut of cuts) {
    const counts = cut.observedCounts;
    if (counts === undefined) {
      return null;
    }
    rows.push(variants.map((variant) => counts[variant] ?? 0));
  }
  const rowTotals = rows.map((row) => row.reduce((sum, n) => sum + n, 0));
  const columnTotals = variants.map((_, columnIndex) =>
    rows.reduce((sum, row) => sum + (row[columnIndex] ?? 0), 0),
  );
  const total = rowTotals.reduce((sum, n) => sum + n, 0);
  if (total === 0 || rowTotals.some((n) => n === 0) || columnTotals.some((n) => n === 0)) {
    return null;
  }
  return { rows, rowTotals, columnTotals, total, variantCount: variants.length };
}

function contingencyChi2(
  rows: readonly number[][],
  rowTotals: readonly number[],
  columnTotals: readonly number[],
  total: number,
): number {
  let chi2Stat = 0;
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    chi2Stat += rowChi2(rows[rowIndex], rowTotals[rowIndex] ?? 0, columnTotals, total);
  }
  return chi2Stat;
}

function rowChi2(
  row: readonly number[] | undefined,
  rowTotal: number,
  columnTotals: readonly number[],
  total: number,
): number {
  if (row === undefined) {
    return 0;
  }
  let chi2Stat = 0;
  for (let columnIndex = 0; columnIndex < columnTotals.length; columnIndex += 1) {
    const observed = row[columnIndex] ?? 0;
    const expected = (rowTotal * (columnTotals[columnIndex] ?? 0)) / total;
    if (expected > 0) {
      chi2Stat += (observed - expected) ** 2 / expected;
    }
  }
  return chi2Stat;
}

function variantUniverse(cuts: readonly SrmRootCauseSegmentCut[]): string[] | null {
  const names = new Set<string>();
  for (const cut of cuts) {
    if (cut.observedCounts === undefined) {
      return null;
    }
    for (const variant of Object.keys(cut.observedCounts)) {
      names.add(variant);
    }
  }
  return [...names].sort();
}

function formatP(pValue: number): string {
  if (pValue === 0) return "0";
  if (pValue < 0.0001) return pValue.toExponential(2);
  return pValue.toFixed(4).replace(/\.?0+$/, "");
}
