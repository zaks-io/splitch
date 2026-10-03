import {
  ANALYSIS_V1_VERSION,
  ANALYSIS_V2_VERSION,
  LEGACY_ANALYSIS_VERSION,
} from "@splitch/contracts";
import type { FamilyCorrectionProcedure } from "./family-correction";

export type SrmProcedure = "chi_square" | "sequential_martingale";
export type GuardrailBoundProcedure = "two_sided_relative" | "one_sided_contrast";

export interface AnalysisVersionPolicy {
  readonly srm: SrmProcedure;
  readonly familyCorrection: FamilyCorrectionProcedure;
  readonly guardrailBound: GuardrailBoundProcedure;
}

/**
 * One explicit, exhaustive switch over known analysis versions. Unknown versions
 * throw; there is no silent fallthrough to the newest (ADR-0059).
 *
 * analysis-v2 selects BH-G: Johari, Pekelis, Walsh Proposition C.3 needs the
 * harmonic correction for arbitrary dependence and an arbitrary stopping time.
 * Plain BH can exceed alpha under a two-null adversarial distribution even when
 * both marginals are superuniform; the ADR-0014 stop simulation asserts BH-G's
 * FDR, which is the procedure v2 freezes.
 *
 * analysis-v2 also selects the Proposition B.1 one-sided Guardrail contrast
 * (C4). legacy and analysis-v1 keep the two-sided Fieller relative lower bound
 * so their result tokens stay byte-identical.
 *
 * analysis-v2 remains defined here for unit tests, but it is not in
 * SUPPORTED_ANALYSIS_VERSIONS until an ingestion-ordered observation path lands.
 */
export function analysisVersionPolicy(version: string): AnalysisVersionPolicy {
  switch (version) {
    case LEGACY_ANALYSIS_VERSION:
    case ANALYSIS_V1_VERSION:
      return {
        srm: "chi_square",
        familyCorrection: "bh",
        guardrailBound: "two_sided_relative",
      };
    case ANALYSIS_V2_VERSION:
      return {
        srm: "sequential_martingale",
        familyCorrection: "bh_g",
        guardrailBound: "one_sided_contrast",
      };
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
