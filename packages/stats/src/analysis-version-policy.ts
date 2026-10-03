import {
  ANALYSIS_V1_VERSION,
  ANALYSIS_V2_VERSION,
  LEGACY_ANALYSIS_VERSION,
} from "@splitch/contracts";
import type { FamilyCorrectionProcedure } from "./family-correction";

export type SrmProcedure = "chi_square" | "sequential_martingale";

export interface AnalysisVersionPolicy {
  readonly srm: SrmProcedure;
  readonly familyCorrection: FamilyCorrectionProcedure;
}

/**
 * One explicit, exhaustive switch over known analysis versions. Unknown versions
 * throw; there is no silent fallthrough to the newest (ADR-0059).
 *
 * analysis-v2 keeps BH: the ADR-0014 amendment recorded BH stop FDR of 0 under
 * stop-at-first-crossing with correlated mixed nulls (alpha 0.05, smoke seed
 * 424242, 300 iterations). Plain BH did not exceed the FDR target, so BH-G is
 * not selected for v2.
 */
export function analysisVersionPolicy(version: string): AnalysisVersionPolicy {
  switch (version) {
    case LEGACY_ANALYSIS_VERSION:
    case ANALYSIS_V1_VERSION:
      return { srm: "chi_square", familyCorrection: "bh" };
    case ANALYSIS_V2_VERSION:
      return { srm: "sequential_martingale", familyCorrection: "bh" };
    default:
      throw new Error(
        `unsupported analysis_version ${JSON.stringify(version)}; known: ${[
          LEGACY_ANALYSIS_VERSION,
          ANALYSIS_V1_VERSION,
          ANALYSIS_V2_VERSION,
        ].join(", ")}`,
      );
  }
}
