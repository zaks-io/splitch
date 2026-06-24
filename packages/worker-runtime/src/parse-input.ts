import type { ErrorResponse } from "@splitch/contracts";
import type { z } from "zod";

/**
 * The raw request surface assembled before Zod validation. A route's `input`
 * schema is authored over this shape: it picks the params/query/headers/body it
 * needs and validates them in one parse.
 */
export interface RawInput {
  params: Record<string, string>;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
}

export type ParseOutcome<T> = { ok: true; value: T } | { ok: false; error: ErrorResponse };

/**
 * Assemble RawInput from a Request + the path params Hono extracted, then parse
 * it with the route's input schema. Body is read as JSON only for methods that
 * carry one; a malformed JSON body is a VALIDATION_ERROR, not a 500.
 */
export async function parseInput<Schema extends z.ZodTypeAny>(
  schema: Schema,
  request: Request,
  params: Record<string, string>,
): Promise<ParseOutcome<z.infer<Schema>>> {
  const raw: RawInput = {
    params,
    query: queryToRecord(request),
    headers: headersToRecord(request.headers),
    body: await readBody(request),
  };

  const result = schema.safeParse(raw);
  if (result.success) {
    return { ok: true, value: result.data };
  }

  return {
    ok: false,
    error: {
      code: "VALIDATION_ERROR",
      message: "request failed schema validation",
      details: {
        issues: result.error.issues.map((issue) => ({
          path: issue.path.map(String),
          message: issue.message,
        })),
      },
    },
  };
}

function queryToRecord(request: Request): Record<string, string> {
  const url = new URL(request.url);
  const out: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    out[key] = value;
  }
  return out;
}

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of headers) {
    out[key] = value;
  }
  return out;
}

async function readBody(request: Request): Promise<unknown> {
  if (request.method === "GET" || request.method === "HEAD") {
    return undefined;
  }
  const text = await request.text();
  if (text.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return MALFORMED_BODY;
  }
}

/**
 * Sentinel for a body that failed JSON parsing. Distinct from `undefined` (no
 * body) so an `input` schema can reject it via VALIDATION_ERROR rather than the
 * guard guessing intent.
 */
export const MALFORMED_BODY = Symbol("malformed-json-body");
