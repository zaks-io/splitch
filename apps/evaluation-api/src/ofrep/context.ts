import type { EvaluateAllRequest } from "@splitch/contracts";
import type { OfrepMappedErrorCode } from "./errors";

export type OfrepContextParse =
  | { ok: true; request: EvaluateAllRequest }
  | { ok: false; errorCode: OfrepMappedErrorCode; errorDetails: string };

const ATTRIBUTE_TYPES = new Set(["boolean", "string", "number"]);

export function parseOfrepContext(input: unknown): OfrepContextParse {
  const body = asObject(input);
  if (body === null) {
    return fail("PARSE_ERROR", "OFREP request body must be a JSON object");
  }
  const context = asObject(body.context);
  if (context === null) {
    return fail("INVALID_CONTEXT", "context is required and must be an object");
  }
  return evaluationRequestFromContext(context);
}

function evaluationRequestFromContext(context: Record<string, unknown>): OfrepContextParse {
  if (typeof context.targetingKey !== "string" || context.targetingKey.length === 0) {
    return fail("TARGETING_KEY_MISSING", "Context is missing required targetingKey property");
  }
  const idType = context.idType;
  if (idType !== undefined && (typeof idType !== "string" || idType.length === 0)) {
    return fail("INVALID_CONTEXT", "idType must be a non-empty string when present");
  }
  const attributes = collectAttributes(context);
  if (!attributes.ok) return attributes;
  return {
    ok: true,
    request: {
      targetingKey: context.targetingKey,
      idType: typeof idType === "string" ? idType : "user",
      attributes: attributes.value,
    },
  };
}

function collectAttributes(
  context: Record<string, unknown>,
):
  | { ok: true; value: EvaluateAllRequest["attributes"] }
  | { ok: false; errorCode: OfrepMappedErrorCode; errorDetails: string } {
  const attributes: EvaluateAllRequest["attributes"] = {};
  for (const [name, value] of Object.entries(context)) {
    if (name === "targetingKey" || name === "idType") continue;
    if (name === "__proto__") {
      return fail("INVALID_CONTEXT", "context must not contain a __proto__ key");
    }
    const parsed = attributeValue(value);
    if (!parsed.ok) {
      return fail("INVALID_CONTEXT", `context.${name} is not a boolean, string, number, or array`);
    }
    attributes[name] = parsed.value;
  }
  return { ok: true, value: attributes };
}

function attributeValue(
  value: unknown,
): { ok: true; value: EvaluateAllRequest["attributes"][string] } | { ok: false } {
  if (value === null) return { ok: false };
  if (ATTRIBUTE_TYPES.has(typeof value)) {
    return { ok: true, value: value as EvaluateAllRequest["attributes"][string] };
  }
  if (Array.isArray(value)) return { ok: true, value };
  return { ok: false };
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function fail(
  errorCode: OfrepMappedErrorCode,
  errorDetails: string,
): { ok: false; errorCode: OfrepMappedErrorCode; errorDetails: string } {
  return { ok: false, errorCode, errorDetails };
}
