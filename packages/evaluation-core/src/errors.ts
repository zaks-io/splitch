import type { ErrorCode } from "@splitch/contracts";

export class AssignmentStoreError extends Error {
  readonly errorCode = "INTERNAL_SERVER_ERROR";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AssignmentStoreError";
  }
}

export class ProviderError extends Error {
  readonly errorCode: ErrorCode;
  readonly resolutionReason: "ERROR" | "STALE";

  constructor(
    message: string,
    options: { cause?: unknown; errorCode?: ErrorCode; resolutionReason?: "ERROR" | "STALE" } = {},
  ) {
    super(message, options);
    this.name = "ProviderError";
    this.errorCode = options.errorCode ?? "INTERNAL_SERVER_ERROR";
    this.resolutionReason = options.resolutionReason ?? "ERROR";
  }
}

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

export class ConditionMatchError extends Error {
  readonly errorCode: ErrorCode;

  constructor(
    message: string,
    errorCode: ErrorCode = "INTERNAL_SERVER_ERROR",
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ConditionMatchError";
    this.errorCode = errorCode;
  }
}
