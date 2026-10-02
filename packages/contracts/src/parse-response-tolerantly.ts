/**
 * Client-side RESPONSE parsing that stays forward-compatible with additive
 * server fields. Schemas remain `.strict()` so the contract documents the
 * exact shape and tests can assert it; this helper is the only place that
 * drops unknown keys. Requests stay strict and never use this path.
 *
 * Algorithm: safeParse; when every issue is `unrecognized_keys`, delete
 * exactly those keys at their issue paths from a structured clone and
 * re-parse. Ordinary `z.union` failures are retried per branch with the same
 * rules; when more than one branch accepts after stripping, the last matching
 * branch wins so hydrated Flag envelopes keep `configurations` (matching the
 * `[bare, hydrated]` authoring order). Any other issue (wrong type, missing
 * required field, refine failure) fails loud unchanged. A failure without Zod
 * issues (custom panel parsers) also fails loud unchanged.
 *
 * Secret-bearing / provision-once credential fields (`keyMaterial`, `value`)
 * are never stripped: an unrecognized occurrence fails loud so a Worker
 * regression cannot hide a wire disclosure behind forward-compat stripping
 * (ADR-0022).
 */

const MAX_STRIP_PASSES = 16;

/**
 * Fields that must never be dropped as "additive unknowns".
 * `keyMaterial` on an APIKey-shaped list row, and CreateCredentialResponse's
 * once-only `value` when it appears outside a create envelope, are contract
 * violations rather than forward-compatible extensions.
 */
const NEVER_STRIP_UNRECOGNIZED_KEYS = new Set(["keyMaterial", "value"]);

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
  readonly errors?: readonly (readonly ResponseParseIssue[])[];
};

export type ResponseSafeParseSchema<T> = {
  safeParse(input: unknown): ResponseParseSuccess<T> | { success: false; error?: unknown };
};

type StripOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; failure: { success: false; error?: unknown } };

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
): StripOutcome<T> {
  // Ordinary z.union collapses to one branch's unrecognized_keys when siblings
  // abort. Blindly stripping those keys would drop hydrated fields such as
  // `configurations`. Resolve unions per-branch before any strip pass.
  const unionParsed = parseUnionBranchesTolerantly(schema, input);
  if (unionParsed !== undefined) return unionParsed;
  return stripUnrecognizedUntilValid(schema, input);
}

function stripUnrecognizedUntilValid<T>(
  schema: ResponseSafeParseSchema<T>,
  input: unknown,
): StripOutcome<T> {
  let candidate = input;
  let lastFailure: { success: false; error?: unknown } | undefined;
  for (let pass = 0; pass < MAX_STRIP_PASSES; pass += 1) {
    const parsed = schema.safeParse(candidate);
    if (parsed.success) return { ok: true, data: parsed.data };
    lastFailure = parsed;
    const failure = asParseFailure(parsed);
    if (hasNeverStripUnrecognizedKeys(failure) || !onlyUnrecognizedKeyIssues(failure)) {
      return { ok: false, failure: parsed };
    }
    candidate = stripUnrecognizedKeys(candidate, failure.error?.issues ?? []);
  }
  const finalParsed = schema.safeParse(candidate);
  if (finalParsed.success) return { ok: true, data: finalParsed.data };
  return { ok: false, failure: lastFailure ?? finalParsed };
}

function parseUnionBranchesTolerantly<T>(
  schema: ResponseSafeParseSchema<T>,
  input: unknown,
): StripOutcome<T> | undefined {
  const options = unionOptions(schema);
  if (options === undefined) return undefined;

  const outcomes = options.map((option) => parseWithStripping(option, input));
  const successIndexes = collectSuccessIndexes(outcomes);
  if (successIndexes.length === 0) {
    return firstUnionFailure(schema, input, outcomes);
  }

  // Hydrated Flag members are authored after the bare member; prefer the last
  // tolerant match so `configurations` is kept when both branches accept.
  const chosenIndex = successIndexes[successIndexes.length - 1] ?? -1;
  const chosen = outcomes[chosenIndex];
  if (!chosen?.ok) {
    return firstUnionFailure(schema, input, outcomes);
  }
  const blocked = blockedByLaterFatalBranch<T>(outcomes, chosenIndex, input, chosen.data as T);
  if (blocked) return blocked;
  return { ok: true, data: chosen.data as T };
}

function collectSuccessIndexes(outcomes: readonly StripOutcome<unknown>[]): number[] {
  const successIndexes: number[] = [];
  for (let index = 0; index < outcomes.length; index += 1) {
    if (outcomes[index]?.ok) successIndexes.push(index);
  }
  return successIndexes;
}

function firstUnionFailure<T>(
  schema: ResponseSafeParseSchema<T>,
  input: unknown,
  outcomes: readonly StripOutcome<unknown>[],
): StripOutcome<T> {
  const unionFailure = schema.safeParse(input);
  if (!unionFailure.success) return { ok: false, failure: unionFailure };
  for (const outcome of outcomes) {
    if (!outcome.ok) return { ok: false, failure: outcome.failure };
  }
  return { ok: false, failure: { success: false } };
}

function blockedByLaterFatalBranch<T>(
  outcomes: readonly StripOutcome<unknown>[],
  chosenIndex: number,
  input: unknown,
  chosenData: T,
): StripOutcome<T> | undefined {
  for (let index = chosenIndex + 1; index < outcomes.length; index += 1) {
    const later = outcomes[index];
    if (!later || later.ok) continue;
    // A more-specific branch fatally rejected keys that the earlier success
    // only accepted by stripping them (e.g. bare Flag dropping malformed
    // `configurations`). Discriminator mismatches on keys that remain in the
    // successful output must not block.
    if (successStrippedKeysReferencedByFailure(input, chosenData, later.failure)) {
      return { ok: false, failure: later.failure };
    }
  }
  return undefined;
}

function successStrippedKeysReferencedByFailure(
  input: unknown,
  successData: unknown,
  failure: { success: false; error?: unknown },
): boolean {
  const strippedPaths = strippedKeyPaths(input, successData, []);
  if (strippedPaths.length === 0) return false;
  const issues = asParseFailure(failure).error?.issues;
  if (!Array.isArray(issues)) return false;
  // Nested strips count too: a hydrated list whose `items[0].configurations`
  // is malformed must not pass as a summary list by dropping `configurations`.
  return issues.some((issue) => strippedPaths.some((path) => isPathPrefix(path, issue.path)));
}

/** Paths of keys present in `input` but absent from the parsed `successData`, at any depth. */
function strippedKeyPaths(
  input: unknown,
  successData: unknown,
  base: readonly PropertyKey[],
): PropertyKey[][] {
  if (Array.isArray(input) && Array.isArray(successData)) {
    return input.flatMap((item, index) =>
      strippedKeyPaths(item, successData[index], [...base, index]),
    );
  }
  if (!isPlainRecord(input) || !isPlainRecord(successData)) return [];
  return Object.keys(input).flatMap((key) =>
    key in successData
      ? strippedKeyPaths(input[key], successData[key], [...base, key])
      : [[...base, key]],
  );
}

function isPathPrefix(prefix: readonly PropertyKey[], path: readonly PropertyKey[]): boolean {
  return prefix.length <= path.length && prefix.every((segment, index) => segment === path[index]);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unionOptions(
  schema: ResponseSafeParseSchema<unknown>,
): ResponseSafeParseSchema<unknown>[] | undefined {
  const record = schema as {
    readonly _def?: { readonly type?: string; readonly options?: unknown };
    readonly def?: { readonly type?: string; readonly options?: unknown };
  };
  const def = record._def ?? record.def;
  if (def?.type !== "union" || !Array.isArray(def.options)) return undefined;
  const options = def.options.filter(
    (option): option is ResponseSafeParseSchema<unknown> =>
      typeof option === "object" &&
      option !== null &&
      typeof (option as ResponseSafeParseSchema<unknown>).safeParse === "function",
  );
  return options.length > 0 ? options : undefined;
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

function hasNeverStripUnrecognizedKeys(parsed: ResponseParseFailure): boolean {
  const issues = parsed.error?.issues;
  if (!Array.isArray(issues)) return false;
  return issues.some((issue) => issueHasNeverStripKey(issue));
}

function issueHasNeverStripKey(issue: ResponseParseIssue): boolean {
  if (issue.code !== "unrecognized_keys" || !Array.isArray(issue.keys)) return false;
  return issue.keys.some((key: string) => NEVER_STRIP_UNRECOGNIZED_KEYS.has(key));
}

function stripUnrecognizedKeys(input: unknown, issues: readonly ResponseParseIssue[]): unknown {
  const clone = structuredClone(input);
  for (const issue of issues) {
    deleteUnrecognizedKeysAtIssue(clone, issue);
  }
  return clone;
}

function deleteUnrecognizedKeysAtIssue(clone: unknown, issue: ResponseParseIssue): void {
  if (issue.code !== "unrecognized_keys" || issue.keys === undefined) return;
  const target = valueAtPath(clone, issue.path);
  if (target === null || typeof target !== "object") {
    throw new Error(
      `parseResponseTolerantly: unrecognized_keys path ${JSON.stringify(issue.path)} did not resolve to an object`,
    );
  }
  const record = target as Record<string, unknown>;
  for (const key of issue.keys) {
    if (NEVER_STRIP_UNRECOGNIZED_KEYS.has(key)) {
      throw new Error(
        `parseResponseTolerantly: refused to strip secret-bearing response key ${JSON.stringify(key)}`,
      );
    }
    delete record[key];
  }
}

function valueAtPath(root: unknown, path: readonly PropertyKey[]): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<PropertyKey, unknown>)[segment];
  }
  return current;
}
