import { validationError } from "./errors.js";
import type { Outcome, Payload } from "./types.js";

export async function readJsonObject(request: Request): Promise<Outcome<Payload>> {
  const text = await request.text();
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
