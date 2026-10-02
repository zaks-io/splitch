import type {
  EvaluateAllEntry,
  OfrepEvaluationFailure,
  OfrepEvaluationSuccess,
} from "@splitch/contracts";

export function mapEvaluateAllEntry(
  key: string,
  entry: EvaluateAllEntry,
): OfrepEvaluationSuccess | OfrepEvaluationFailure {
  if (entry.reason === "ERROR") {
    return {
      key,
      errorCode: ofrepErrorCode(entry.errorCode),
      errorDetails: entry.errorCode ?? "flag evaluation failed",
    };
  }
  const metadata = ticketMetadata(entry);
  const success: OfrepEvaluationSuccess = {
    key,
    reason: entry.reason === "DEFAULT" ? "STATIC" : entry.reason,
    ...(entry.variantName === null ? {} : { variant: entry.variantName }),
    ...(metadata === undefined ? {} : { metadata }),
  };
  if (entry.variant === null) return success;
  return { ...success, value: entry.variant };
}

function ticketMetadata(entry: EvaluateAllEntry): Record<string, string> | undefined {
  if (entry.exposureTicket === null || entry.exposureIdentity === null) return undefined;
  return {
    exposureTicket: entry.exposureTicket,
    exposureIdentity: entry.exposureIdentity,
  };
}

function ofrepErrorCode(code: EvaluateAllEntry["errorCode"]): OfrepEvaluationFailure["errorCode"] {
  if (code === "FLAG_NOT_FOUND") return "FLAG_NOT_FOUND";
  if (code === "VALIDATION_ERROR") return "INVALID_CONTEXT";
  return "GENERAL";
}
