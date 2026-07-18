import type { ErrorResponse } from "@splitch/contracts";
import type { EvaluationUsageSink } from "./evaluation-usage-sink";
import { EvaluationUsageSinkError } from "./evaluation-usage-sink";

export interface EvaluationUsageScope {
  readonly organizationId: string;
  readonly appId: string;
  readonly environmentId: string;
}

export async function writeEvaluationUsage(
  hasExposure: boolean,
  idempotencyKey: string,
  scope: EvaluationUsageScope,
  dimensions: { readonly flagKey: string; readonly sdkRuntime: string },
  deps: {
    readonly evaluationUsageSink: EvaluationUsageSink;
    readonly logger?: Pick<Console, "error">;
  },
  serviceUnavailable: () => ErrorResponse,
  isCached = false,
): Promise<{ ok: true } | { ok: false; error: ErrorResponse }> {
  try {
    await deps.evaluationUsageSink.write({
      idempotencyKey,
      organizationId: scope.organizationId,
      appId: scope.appId,
      environmentId: scope.environmentId,
      flagKey: dimensions.flagKey,
      sdkRuntime: dimensions.sdkRuntime,
      evaluationCount: isCached ? 0 : 1,
      isBatch: false,
      isCached,
      hasExposure,
    });
    return { ok: true };
  } catch (cause) {
    if (!(cause instanceof EvaluationUsageSinkError)) {
      throw cause;
    }
    deps.logger?.error("evaluation_usage_sink_failed", { cause });
    return { ok: false, error: serviceUnavailable() };
  }
}
