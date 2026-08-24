import type { EvaluateAllReason } from "@splitch/contracts";
import type { EvaluateResult } from "./evaluate/evaluate-path-types";

export function reasonForResolution(
  result: Exclude<EvaluateResult, { kind: "error" }>,
): Exclude<EvaluateAllReason, "ERROR"> {
  if (result.kind === "disabled") return "DISABLED";
  if (result.kind === "no_match_default" || result.kind === "null_experiment") return "DEFAULT";
  return "SPLIT";
}
