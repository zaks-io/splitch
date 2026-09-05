import { SplitchSdkError } from "./errors";
import type { EvaluateDeps, EvaluationContext } from "./evaluate";

// Resolve before the seen-set so invalid keys fail consistently on hits and misses.
export function resolveIdempotencyKey(
  deps: EvaluateDeps,
  flagKey: string,
  context: EvaluationContext,
): string {
  const key: unknown = context.idempotencyKey;
  if (typeof key === "string" && key.length > 0) return key;
  if (key === undefined && typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  const error = new SplitchSdkError(
    key === undefined
      ? {
          code: "SDK_IDEMPOTENCY_KEY_UNAVAILABLE",
          causeSummary:
            "crypto.randomUUID is unavailable, so evaluate could not generate an idempotencyKey",
          remediation: "Pass an idempotencyKey or use a runtime with crypto.randomUUID available",
        }
      : {
          code: "SDK_CONTEXT_INVALID",
          causeSummary: "evaluate received an invalid idempotencyKey",
          remediation:
            "Omit idempotencyKey to generate one, or pass a non-empty string reused for retries",
        },
  );
  deps.logger.error(error.message, {
    flagKey,
    targetingKey: context.targetingKey,
    status: error.status,
    errorCode: error.code,
  });
  throw error;
}
