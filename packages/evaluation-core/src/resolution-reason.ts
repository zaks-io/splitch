import type { ResolutionReason } from "@splitch/contracts";
import type { EvaluateResult } from "./types";

type SuccessfulEvaluateKind = Exclude<EvaluateResult["kind"], "error">;
type SuccessfulResolutionReason = Exclude<ResolutionReason, "ERROR" | "STALE">;

/** One flat reason vocabulary for every adapter over the shared evaluator. */
export function resolutionReasonFor(kind: SuccessfulEvaluateKind): SuccessfulResolutionReason {
  if (kind === "disabled") return "DISABLED";
  if (kind === "rule_match_direct" || kind === "rule_match_percentage") {
    return "TARGETING_MATCH";
  }
  if (kind === "holdover_replay") return "CACHED";
  if (kind === "no_match_default" || kind === "no_live_run" || kind === "null_experiment") {
    return "DEFAULT";
  }
  return "SPLIT";
}
