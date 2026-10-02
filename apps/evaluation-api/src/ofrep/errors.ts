import type { OfrepEvaluationFailure } from "@splitch/contracts";

export type OfrepMappedErrorCode =
  | "PARSE_ERROR"
  | "TARGETING_KEY_MISSING"
  | "INVALID_CONTEXT"
  | "FLAG_NOT_FOUND"
  | "GENERAL";

function ofrepFailureResponse(
  status: number,
  body: OfrepEvaluationFailure | { errorCode: OfrepMappedErrorCode; errorDetails: string },
): Response {
  return Response.json(body, { status });
}

export function ofrepFlagNotFound(key: string): Response {
  return ofrepFailureResponse(404, {
    key,
    errorCode: "FLAG_NOT_FOUND",
    errorDetails: `Flag '${key}' was not found`,
  });
}

export function ofrepRequestFailure(
  errorCode: OfrepMappedErrorCode,
  errorDetails: string,
  key?: string,
): Response {
  if (errorCode === "FLAG_NOT_FOUND" && key !== undefined) {
    return ofrepFlagNotFound(key);
  }
  return ofrepFailureResponse(
    400,
    key === undefined ? { errorCode, errorDetails } : { key, errorCode, errorDetails },
  );
}

export function ofrepServerError(errorDetails: string): Response {
  return Response.json({ errorDetails }, { status: 500 });
}
