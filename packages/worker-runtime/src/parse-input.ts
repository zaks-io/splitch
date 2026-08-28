import { readBoundedRequestBytes, trustedContentLength } from "@splitch/bounded-body";
import type { ErrorResponse, RawBodyByteLimit } from "@splitch/contracts";
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

export type ParseOutcome<T> =
  | { ok: true; value: T; request: Request }
  | { ok: false; error: ErrorResponse };

/**
 * Assemble RawInput from a Request + the path params Hono extracted, then parse
 * it with the route's input schema. Body is read as JSON only for methods that
 * carry one; a malformed JSON body is a VALIDATION_ERROR, not a 500.
 */
export async function parseInput<Schema extends z.ZodTypeAny>(
  schema: Schema,
  request: Request,
  params: Record<string, string>,
  rawBodyByteLimit?: RawBodyByteLimit,
): Promise<ParseOutcome<z.infer<Schema>>> {
  const body = await readBody(request, rawBodyByteLimit);
  if (!body.ok) {
    return { ok: false, error: body.error };
  }

  const raw: RawInput = {
    params,
    query: queryToRecord(request),
    headers: headersToRecord(request.headers),
    body: body.value,
  };

  const result = schema.safeParse(raw);
  if (result.success) {
    return { ok: true, value: result.data, request: body.request };
  }

  return {
    ok: false,
    error: {
      code: "VALIDATION_ERROR",
      message: "request failed schema validation",
      details: {
        issues: validationIssues(result.error),
      },
    },
  };
}

function validationIssues(error: z.ZodError): Array<{ path: string[]; message: string }> {
  return error.issues.flatMap((issue) => {
    if (issue.code === "unrecognized_keys") {
      return issue.keys.map((key) => ({
        path: [...issue.path.map(String), key],
        message: `Unrecognized key: "${key}"`,
      }));
    }
    return [{ path: issue.path.map(String), message: issue.message }];
  });
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

type BodyReadOutcome =
  | { ok: true; value: unknown; request: Request }
  | { ok: false; error: ErrorResponse };

async function readBody(
  request: Request,
  rawBodyByteLimit: RawBodyByteLimit | undefined,
): Promise<BodyReadOutcome> {
  if (request.method === "GET" || request.method === "HEAD") {
    return { ok: true, value: undefined, request };
  }

  // Unbounded only when a caller opts out of a limit. The registrar never
  // reaches this path for mutating JSON routes: it always passes
  // rawBodyByteLimitFor(contract). Standalone Auth/MCP/Event Ingest/Convex
  // readers call readBoundedRequestBody instead of this unbounded fallback.
  if (rawBodyByteLimit === undefined) {
    return {
      ok: true,
      value: parseBodyText(await request.clone().text()),
      request,
    };
  }

  const contentLength = trustedContentLength(request.headers.get("content-length"));
  if (contentLength !== null && contentLength > rawBodyByteLimit.maxBytes) {
    return { ok: false, error: rawBodyByteLimit.error };
  }

  const bytes = await readBoundedRequestBytes(request.body, rawBodyByteLimit.maxBytes);
  if (bytes === null) {
    return { ok: false, error: rawBodyByteLimit.error };
  }

  return {
    ok: true,
    value: parseBodyText(new TextDecoder().decode(bytes)),
    request: replayRequest(request, bytes),
  };
}

function parseBodyText(text: string): unknown {
  if (text.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return MALFORMED_BODY;
  }
}

function replayRequest(request: Request, bytes: Uint8Array): Request {
  const body = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(body).set(bytes);
  return new Request(request, { body });
}

/**
 * Sentinel for a body that failed JSON parsing. Distinct from `undefined` (no
 * body) so an `input` schema can reject it via VALIDATION_ERROR rather than the
 * guard guessing intent.
 */
export const MALFORMED_BODY = Symbol("malformed-json-body");
