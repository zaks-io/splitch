import type { ErrorResponse, EvaluateAllResponse } from "@splitch/contracts";
import {
  noopPerformanceSpanRecorder,
  type PerformanceSpanRecorder,
} from "@splitch/observability/performance-spans";
import {
  type AppIdentityAdmission,
  appIdentityAdmissionValidationError,
} from "./app-identity-traffic";
import { sdkRuntime } from "./evaluate-response";
import type { EvaluationCommitSink } from "./evaluation-commit-sink";
import { EvaluationCommitSinkError } from "./evaluation-commit-sink";
import { errorResponse } from "./evaluation-error-response";
import type { EvaluationUsageScope } from "./evaluation-usage";

/**
 * Batch Flag Key used on the Evaluation usage row for an evaluate-all fetch.
 * Per-Flag breakdown for batches is a reporting concern on `is_batch` + count;
 * the Idempotency-Key is the single billing replay identity (ADR-0033).
 */
const BATCH_USAGE_FLAG_KEY = "*";

export async function writeEvaluateAllUsage(
  body: EvaluateAllResponse,
  scope: EvaluationUsageScope,
  request: Request,
  deps: {
    readonly evaluationCommitSink: EvaluationCommitSink;
    readonly logger?: Pick<Console, "error">;
    readonly spans?: PerformanceSpanRecorder;
  },
  admission: AppIdentityAdmission,
  idempotencyKey: string,
): Promise<{ ok: true } | { ok: false; error: ErrorResponse }> {
  const flagCount = Object.keys(body.evaluations).length;
  if (flagCount === 0) return { ok: true };

  const stale = await appIdentityAdmissionValidationError(admission);
  if (stale !== null) return { ok: false, error: stale };

  try {
    await (deps.spans ?? noopPerformanceSpanRecorder).record(
      { name: "Evaluate-all usage commit", op: "http.client" },
      () =>
        deps.evaluationCommitSink.write({
          usage: {
            idempotencyKey,
            organizationId: scope.organizationId,
            appId: scope.appId,
            identityVersion: admission.identityVersion,
            environmentId: scope.environmentId,
            flagKey: BATCH_USAGE_FLAG_KEY,
            sdkRuntime: sdkRuntime(request),
            evaluationCount: flagCount,
            isBatch: true,
            isCached: false,
            hasExposure: false,
          },
          exposures: [],
        }),
    );
    return { ok: true };
  } catch (cause) {
    if (!(cause instanceof EvaluationCommitSinkError)) throw cause;
    deps.logger?.error("evaluate_all_usage_sink_failed", { cause });
    return {
      ok: false,
      error: errorResponse(
        "SERVICE_UNAVAILABLE",
        "evaluation usage commit is temporarily unavailable",
      ),
    };
  }
}
