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
 *
 * Phone-like matching skips digit runs that sit inside a minted resource id
 * (`apr_…`, `flag_…`, …). A ULID/hex body can contain 8+ consecutive digits; those
 * are not phone numbers, and redacting them leaves a fault row unable to name
 * what failed.
 */

import { REDACTED } from "./redaction-rules";

/** Email: local@domain.tld. Every quantifier is BOUNDED ({1,64}/{1,255}/{2,24}),
 * so worst-case backtracking is capped — no catastrophic ReDoS on adversarial
 * `a@a.a.a…`-with-no-TLD input (the old unbounded `[A-Z0-9.-]+\.[A-Z]{2,}` had
 * an overlapping dot class and backtracked quadratically). */
const EMAIL_PATTERN = /[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,255}\.[A-Z]{2,24}/gi;

/** Phone-like: 7+ digits with optional separators/+ (avoids tiny numbers). */
const PHONE_LIKE_PATTERN = /\+?\d[\d\s().-]{6,}\d/g;

/**
 * Server-minted resource-id prefixes. Credential material (`sk_`, `pk_`, `spl_`)
 * is intentionally absent — those stay redacted by observability `extraPatterns`.
 */
const MINTED_ID_PREFIXES = [
  "apr",
  "rev",
  "org",
  "app",
  "env",
  "flag",
  "var",
  "exp",
  "run",
  "metric",
  "segment",
  "rule",
  "salt",
  "ak",
  "ck",
  "idp",
  "user",
  "prv",
  "cver",
  "ccons",
] as const;

const MINTED_ID_TOKEN = new RegExp(`^(?:${MINTED_ID_PREFIXES.join("|")})_[0-9A-Za-z]+$`, "i");

const WORD_CHAR = /[0-9A-Za-z_]/;

export interface ValuePatternOptions {
  /** App-specific value shapes (e.g. a Targeting Key prefix) to also redact. */
  extraPatterns?: readonly RegExp[];
}

/**
 * Expand a match to the surrounding `[A-Za-z0-9_]+` token so a digit run inside
 * `apr_01J…` is judged as part of that id, not as a bare phone.
 */
function enclosingToken(text: string, start: number, end: number): string {
  let lo = start;
  let hi = end;
  while (lo > 0 && WORD_CHAR.test(text.charAt(lo - 1))) lo -= 1;
  while (hi < text.length && WORD_CHAR.test(text.charAt(hi))) hi += 1;
  return text.slice(lo, hi);
}

function isInsideMintedId(text: string, matchStart: number, matchLength: number): boolean {
  return MINTED_ID_TOKEN.test(enclosingToken(text, matchStart, matchStart + matchLength));
}

function redactPhoneLike(text: string): string {
  return text.replace(
    new RegExp(PHONE_LIKE_PATTERN.source, PHONE_LIKE_PATTERN.flags),
    (match, offset: number) => (isInsideMintedId(text, offset, match.length) ? match : REDACTED),
  );
}

/**
 * Replace every match of the configured PII value patterns in `text` with the
 * placeholder. Used by the string scrubber as a pass alongside embedded-JSON
 * scrubbing. Pure: returns a new string.
 */
export function redactValuePatterns(text: string, options: ValuePatternOptions = {}): string {
  let result = text;
  result = result.replace(new RegExp(EMAIL_PATTERN.source, EMAIL_PATTERN.flags), REDACTED);
  result = redactPhoneLike(result);
  for (const pattern of options.extraPatterns ?? []) {
    // Clone with a fresh lastIndex so a global regex is reusable across calls.
    result = result.replace(new RegExp(pattern.source, pattern.flags), REDACTED);
  }
  return result;
}
