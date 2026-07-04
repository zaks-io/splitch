/**
 * Value-shape redaction patterns: catch PII written as a BARE substring inside a
 * message or exception string (e.g. `assign() failed for targetingKey tk_abc`),
 * which neither key-name matching nor JSON parsing can see. The spec requires
 * exception-message + breadcrumb coverage and names "canary emails, phone-like
 * strings, Targeting Keys, and custom attributes" (privacy-data-lifecycle.md:139,
 * observability-pii-scrubbing.md).
 *
 * WHY patterns are extensible, not a fixed list: emails and phones have stable
 * shapes we can always redact, but a Targeting Key is opaque per App. The caller
 * (a Worker) registers its own known-sensitive value shapes via `extraPatterns`,
 * so the same scrubber covers app-specific identifiers without this package
 * guessing them. The defaults are the universally-safe ones.
 */

import { REDACTED } from "./redaction-rules";

/** Email and phone-like shapes are PII wherever they appear, in any string. */
const DEFAULT_VALUE_PATTERNS: readonly RegExp[] = [
  // Email: local@domain.tld. Every quantifier is BOUNDED ({1,64}/{1,255}/{2,24}),
  // so worst-case backtracking is capped — no catastrophic ReDoS on adversarial
  // `a@a.a.a…`-with-no-TLD input (the old unbounded `[A-Z0-9.-]+\.[A-Z]{2,}` had
  // an overlapping dot class and backtracked quadratically).
  /[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,255}\.[A-Z]{2,24}/gi,
  // Phone-like: 7+ digits with optional separators/+ (avoids tiny numbers).
  /\+?\d[\d\s().-]{6,}\d/g,
];

export interface ValuePatternOptions {
  /** App-specific value shapes (e.g. a Targeting Key prefix) to also redact. */
  extraPatterns?: readonly RegExp[];
}

/**
 * Replace every match of the configured PII value patterns in `text` with the
 * placeholder. Used by the string scrubber as a pass alongside embedded-JSON
 * scrubbing. Pure: returns a new string.
 */
export function redactValuePatterns(text: string, options: ValuePatternOptions = {}): string {
  let result = text;
  const patterns = [...DEFAULT_VALUE_PATTERNS, ...(options.extraPatterns ?? [])];
  for (const pattern of patterns) {
    // Clone with a fresh lastIndex so a global regex is reusable across calls.
    result = result.replace(new RegExp(pattern.source, pattern.flags), REDACTED);
  }
  return result;
}
