import type {
  AnalysisResultsEnvelope,
  RunCommitments,
  StatsInput,
  StatsOutput,
} from "@splitch/contracts";
import { computeCohortEffect } from "@splitch/stats";

/** Ready envelope body including cohort_effect; keeps results.ts small. */
export function readyAnalysisEnvelope(args: {
  statsInput: StatsInput;
  runStartedAt: string;
  commitments: RunCommitments;
  stats: StatsOutput;
  evidence: {
    data_watermark?: string;
    result_token?: `sha256:${string}`;
  };
}): Extract<AnalysisResultsEnvelope, { state: "ready" }> {
  return {
    state: "ready",
    run_id: args.statsInput.run_id,
    control_variant: args.statsInput.control_variant,
    ...args.evidence,
    run_commitments: args.commitments,
    // Diagnostic only: beside stats so result_token stays byte-identical.
    cohort_effect: computeCohortEffect({
      statsInput: args.statsInput,
      runStartedAt: args.runStartedAt,
      analysisWatermark: args.evidence.data_watermark,
    }),
    stats: args.stats,
  };
}
