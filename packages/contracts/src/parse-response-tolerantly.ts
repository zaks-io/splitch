/**
 * Client-side RESPONSE parsing that stays forward-compatible with additive
 * server fields. Schemas remain `.strict()` so the contract documents the
 * exact shape and tests can assert it; this helper is the only place that
 * drops unknown keys. Requests stay strict and never use this path.
 *
 * Algorithm: safeParse; when every issue is `unrecognized_keys`, delete
 * exactly those keys at their issue paths from a structured clone and
 * re-parse. Any other issue (wrong type, missing required field, refine
 * failure) fails loud unchanged. A failure without Zod issues (custom
 * panel parsers) also fails loud unchanged.
 */

const MAX_STRIP_PASSES = 16;

export type ResponseParseSuccess<T> = { success: true; data: T };
export type ResponseParseFailure = {
  success: false;
  error?: { readonly issues?: readonly ResponseParseIssue[] };
};
export type ResponseParseResult<T> = ResponseParseSuccess<T> | ResponseParseFailure;

export type ResponseParseIssue = {
  readonly code: string;
  readonly path: readonly PropertyKey[];
  readonly keys?: readonly string[];
  readonly message?: string;
};

export type ResponseSafeParseSchema<T> = {
  safeParse(input: unknown): ResponseParseSuccess<T> | { success: false; error?: unknown };
};

export function parseResponseTolerantly<T>(
  schema: ResponseSafeParseSchema<T>,
  input: unknown,
): ResponseParseResult<T> {
  const outcome = parseWithStripping(schema, input);
  return outcome.ok ? { success: true, data: outcome.data } : asParseFailure(outcome.failure);
}

/** Same as `schema.parse`, but drops additive unknown response keys first. */
export function parseResponseBody<T>(schema: ResponseSafeParseSchema<T>, input: unknown): T {
  const outcome = parseWithStripping(schema, input);
  if (outcome.ok) return outcome.data;
  throw outcome.failure.error ?? new Error("response body failed schema validation");
}

function parseWithStripping<T>(
  schema: ResponseSafeParseSchema<T>,
  input: unknown,
): { ok: true; data: T } | { ok: false; failure: { success: false; error?: unknown } } {
  let candidate = input;
  let lastFailure: { success: false; error?: unknown } | undefined;
  for (let pass = 0; pass < MAX_STRIP_PASSES; pass += 1) {
    const parsed = schema.safeParse(candidate);
    if (parsed.success) return { ok: true, data: parsed.data };
    lastFailure = parsed;
    const failure = asParseFailure(parsed);
    if (!onlyUnrecognizedKeyIssues(failure)) return { ok: false, failure: parsed };
    candidate = stripUnrecognizedKeys(candidate, failure.error?.issues ?? []);
  }
  const finalParsed = schema.safeParse(candidate);
  if (finalParsed.success) return { ok: true, data: finalParsed.data };
  return { ok: false, failure: finalParsed };
}

function asParseFailure(parsed: { success: false; error?: unknown }): ResponseParseFailure {
  if (parsed.error === undefined || parsed.error === null || typeof parsed.error !== "object") {
    return { success: false };
  }
  const issues = (parsed.error as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) {
    return { success: false, error: {} };
  }
  return {
    success: false,
    error: { issues: issues as ResponseParseIssue[] },
  };
}

function onlyUnrecognizedKeyIssues(parsed: ResponseParseFailure): boolean {
  const issues = parsed.error?.issues;
  return (
    Array.isArray(issues) &&
    issues.length > 0 &&
    issues.every(
      (issue) =>
        issue.code === "unrecognized_keys" && Array.isArray(issue.keys) && issue.keys.length > 0,
    )
  );
}

function stripUnrecognizedKeys(input: unknown, issues: readonly ResponseParseIssue[]): unknown {
  const clone = structuredClone(input);
  for (const issue of issues) {
    if (issue.code !== "unrecognized_keys" || issue.keys === undefined) continue;
    const target = valueAtPath(clone, issue.path);
    if (target === null || typeof target !== "object") {
      throw new Error(
        `parseResponseTolerantly: unrecognized_keys path ${JSON.stringify(issue.path)} did not resolve to an object`,
      );
    }
    const record = target as Record<string, unknown>;
    for (const key of issue.keys) {
      delete record[key];
    }
  }
  return clone;
}

function valueAtPath(root: unknown, path: readonly PropertyKey[]): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<PropertyKey, unknown>)[segment];
  }
  return current;
}
