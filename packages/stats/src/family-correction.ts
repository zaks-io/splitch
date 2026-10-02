export const FAMILY_CORRECTION_PROCEDURES = ["bh", "bh_g"] as const;

export type FamilyCorrectionProcedure = (typeof FAMILY_CORRECTION_PROCEDURES)[number];

const PROCEDURES = new Set<string>(FAMILY_CORRECTION_PROCEDURES);

/**
 * Production still defaults to Benjamini-Hochberg. BH-G (Benjamini-Yekutieli
 * with the harmonic sum) is the comparator for arbitrary stopping; analysis
 * version wiring chooses it later.
 */
export function resolveFamilyCorrectionProcedure(
  procedure: FamilyCorrectionProcedure | undefined,
): FamilyCorrectionProcedure {
  if (procedure === undefined) {
    return "bh";
  }
  if (!PROCEDURES.has(procedure)) {
    throw new Error(
      `family_correction must be one of ${FAMILY_CORRECTION_PROCEDURES.join(", ")}; received ${JSON.stringify(procedure)}.`,
    );
  }
  return procedure;
}

export function harmonicNumber(familySize: number): number {
  if (!Number.isInteger(familySize) || familySize < 1) {
    throw new Error("harmonic number requires a positive integer family size.");
  }

  let sum = 0;
  for (let rank = 1; rank <= familySize; rank += 1) {
    sum += 1 / rank;
  }
  return sum;
}

/**
 * BH uses alpha. BH-G uses alpha / H_m, H_m = sum_{i=1..m} 1/i, which is
 * Johari, Pekelis, Walsh Proposition C.3 (Benjamini-Yekutieli).
 */
export function familyCorrectionAlpha(
  alpha: number,
  familySize: number,
  procedure: FamilyCorrectionProcedure,
): number {
  if (procedure === "bh") {
    return alpha;
  }
  return alpha / harmonicNumber(familySize);
}

export function largestRejectedRank(
  sortedAscendingPValues: readonly number[],
  alpha: number,
  procedure: FamilyCorrectionProcedure,
): number {
  const familySize = sortedAscendingPValues.length;
  if (familySize === 0) {
    return 0;
  }

  const correctedAlpha = familyCorrectionAlpha(alpha, familySize, procedure);
  let maxRank = 0;

  for (let index = 0; index < familySize; index += 1) {
    const rank = index + 1;
    const pValue = sortedAscendingPValues[index];
    if (pValue === undefined) {
      throw new Error(`sorted p-values missing rank ${rank}.`);
    }
    if (pValue <= (rank / familySize) * correctedAlpha) {
      maxRank = rank;
    }
  }

  return maxRank;
}
