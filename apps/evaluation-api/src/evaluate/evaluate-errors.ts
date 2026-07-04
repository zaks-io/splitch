import type { ErrorCode } from "@splitch/contracts";
import { AssignmentStoreError } from "../assignment/assignment-store";
import { ProviderError } from "../provider/provider";
import { ConditionMatchError } from "./conditions";
import type { ErrorEvaluateResult, EvaluatePathDeps } from "./evaluate-path-types";

export class EvaluatePathError extends Error {
  readonly errorCode: ErrorCode;

  constructor(
    message: string,
    errorCode: ErrorCode = "INTERNAL_SERVER_ERROR",
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "EvaluatePathError";
    this.errorCode = errorCode;
  }
}

export function errorResult(
  defaultVariant: string | null,
  cause: unknown,
  logger: EvaluatePathDeps["logger"],
): ErrorEvaluateResult {
  const errorCode = errorCodeFor(cause);
  const errorMessage = cause instanceof Error ? cause.message : "Evaluation failed";
  logger?.error("evaluate_path_failed", { cause, errorCode });

  return {
    kind: "error",
    variant: defaultVariant,
    reason: "ERROR",
    errorCode,
    errorMessage,
    liveRunId: null,
    exposure: null,
  };
}

function errorCodeFor(cause: unknown): ErrorCode {
  if (
    cause instanceof ProviderError ||
    cause instanceof EvaluatePathError ||
    cause instanceof AssignmentStoreError ||
    cause instanceof ConditionMatchError
  ) {
    return cause.errorCode;
  }
  return "INTERNAL_SERVER_ERROR";
}
