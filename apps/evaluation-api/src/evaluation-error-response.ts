import type { ErrorCode, ErrorResponse } from "@splitch/contracts";

export type ErrorDisclosure = "public" | "trusted";

const SAFE_PUBLIC_VALIDATION_MESSAGES = new Set([
  "Idempotency-Key is required for Evaluation usage",
  "Idempotency-Key header must match the cached Evaluation telemetry body",
]);

export function errorDisclosureForKind(kind: string): ErrorDisclosure {
  return kind === "api-key" ? "trusted" : "public";
}

export function errorResponse(
  code: ErrorCode,
  message: string,
  options: { disclosure?: ErrorDisclosure } = {},
): ErrorResponse {
  const disclosure = options.disclosure ?? "public";
  if (code === "FLAG_NOT_FOUND") {
    return { code, message: "flag not found", details: {} };
  }
  if (code === "VALIDATION_ERROR") {
    return {
      code,
      message: publicValidationMessage(message, disclosure),
      details: { issues: [] },
    };
  }
  if (code === "UNSUPPORTED_OBJECT_KEY") {
    return {
      code,
      message,
      details: { key: "__proto__", path: ["evaluations", "__proto__"] },
    };
  }
  if (code === "INTERNAL_SERVER_ERROR") {
    return { code, message: "evaluation failed", details: {} };
  }
  if (code === "SERVICE_UNAVAILABLE") {
    return { code, message, details: { retryAfterMs: 1000 } };
  }
  return { code, message, details: {} } as ErrorResponse;
}

function publicValidationMessage(message: string, disclosure: ErrorDisclosure): string {
  if (disclosure === "trusted") return message;
  if (SAFE_PUBLIC_VALIDATION_MESSAGES.has(message)) return message;
  if (message.includes("idType") && message.includes("targetingKeyType")) {
    return "idType does not match the Experiment";
  }
  return "request is invalid";
}
