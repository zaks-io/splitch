/**
 * Shared redaction scrubber. EVERY Worker, CLI, MCP, and SDK test harness calls
 * this before any Sentry/Axiom/log emission (docs/spec/platform/privacy-data-
 * lifecycle.md "Redaction rules"; observability-pii-scrubbing.md). Frontend-only
 * scrubbing is a spec bug.
 *
 * Behaviour: replaces matched VALUES with `[Redacted]`, never deletes keys. It
 * recurses through nested objects and arrays. Each STRING gets two passes so PII
 * hidden in prose is caught regardless of how it was written:
 *   1. embedded-JSON scrub — a stringified context glued into a message.
 *   2. value-pattern scrub — a bare email / phone / Targeting Key interpolated
 *      into a message (`assign() failed for tk_abc`), which JSON parsing misses.
 *
 * This file owns traversal only; redaction-rules.ts / value-patterns.ts own policy.
 */

import { scrubEmbeddedJson } from "./embedded-json.js";
import { isContainerKey, isLeafPiiKey, REDACTED } from "./redaction-rules.js";
import { redactValuePatterns, type ValuePatternOptions } from "./value-patterns.js";

type Json = unknown;

const MAX_DEPTH = 64;

export type ScrubOptions = ValuePatternOptions;

function isPlainObject(value: unknown): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scrubString(value: string, depth: number, options: ScrubOptions): string {
  const withoutJson = scrubEmbeddedJson(value, (parsed) => scrubValue(parsed, options, depth + 1));
  return redactValuePatterns(withoutJson, options);
}

function scrubObject(
  input: Record<string, Json>,
  options: ScrubOptions,
  depth: number,
): Record<string, Json> {
  const output: Record<string, Json> = {};
  for (const [key, value] of Object.entries(input)) {
    output[key] =
      isContainerKey(key) || isLeafPiiKey(key) ? REDACTED : scrubValue(value, options, depth + 1);
  }
  return output;
}

/** Recursively scrub any JSON-like value. Pure: returns a new structure. */
export function scrubValue(value: Json, options: ScrubOptions = {}, depth = 0): Json {
  if (depth > MAX_DEPTH) {
    return REDACTED;
  }
  if (typeof value === "string") {
    return scrubString(value, depth, options);
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubValue(item, options, depth + 1));
  }
  if (isPlainObject(value)) {
    return scrubObject(value, options, depth);
  }
  return value;
}
