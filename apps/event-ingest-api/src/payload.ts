import { DEFAULT_MUTATING_JSON_BODY_MAX_BYTES } from "@splitch/contracts";
import { readBoundedRequestBody } from "@splitch/worker-runtime";
import { validationError } from "./errors";
import type { Outcome, Payload } from "./types";

export const EVENT_INGEST_MAX_BODY_BYTES = DEFAULT_MUTATING_JSON_BODY_MAX_BYTES;

export async function readJsonObject(request: Request): Promise<Outcome<Payload>> {
  const bounded = await readBoundedRequestBody(request, {
    maxBytes: EVENT_INGEST_MAX_BODY_BYTES,
    allowedMediaTypes: ["application/json"],
  });
  if (!bounded.ok) {
    return {
      ok: false,
      error:
        bounded.reason === "too_large"
          ? validationError("request body is too large", ["body"])
          : validationError("request body must be application/json", ["body"]),
    };
  }
  const text = bounded.text;
  if (text.length === 0) {
    return { ok: false, error: validationError("request body is required", ["body"]) };
  }

  try {
    const body: unknown = JSON.parse(text);
    if (body === null || Array.isArray(body) || typeof body !== "object") {
      return { ok: false, error: validationError("request body must be a JSON object", ["body"]) };
    }
    return { ok: true, value: body as Payload };
  } catch {
    return { ok: false, error: validationError("request body must be valid JSON", ["body"]) };
  }
}

export function stringField(payload: Payload, field: string): Outcome<string> {
  const value = stringValue(payload[field]);
  if (value === null) {
    return { ok: false, error: validationError(`${field} is required`, ["body", field]) };
  }
  return { ok: true, value };
}

export function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
