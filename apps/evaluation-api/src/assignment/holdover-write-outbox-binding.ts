import type { EvaluationApiEnv } from "../env";

/**
 * Per-request fail-loud for the SPL-346 holdover retry outbox binding.
 * Called from the Worker request path when constructing the exposures
 * coordinator — not at module load. `/health` does not exercise this check.
 */
export function requiredHoldoverWriteOutboxBinding(
  binding: EvaluationApiEnv["HOLDOVER_WRITE_OUTBOX"],
): NonNullable<EvaluationApiEnv["HOLDOVER_WRITE_OUTBOX"]> {
  if (!binding) throw new Error("evaluation-api: HOLDOVER_WRITE_OUTBOX is required");
  return binding;
}
