import { z } from "zod";

/**
 * The one slug shape in the system.
 *
 * Organization slugs and App keys are both caller-chosen handles that appear in
 * selectors, so they must agree on what a valid handle looks like: a caller who
 * learns the rule from one should never be surprised by the other, and a client
 * validating locally must not accept what the API then rejects. They differ only
 * in what they additionally forbid (Organizations reserve the Panel's top-level
 * route segments), so that belongs on top of this, not in a second pattern.
 *
 * The `_`-free alphabet is also a security property: canonical identifiers carry
 * `_` (`app_...`, `org_...`), so a handle can never take an identifier's shape
 * and impersonate another tenant's resource in a selector lookup.
 */

export const SLUG_MIN_LENGTH = 2;
export const SLUG_MAX_LENGTH = 63;

/** Lowercase alphanumerics with single internal hyphens; no leading/trailing hyphen. */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const SlugSchema = z
  .string()
  .min(SLUG_MIN_LENGTH)
  .max(SLUG_MAX_LENGTH)
  .regex(SLUG_PATTERN, "must be lowercase alphanumerics separated by single hyphens");

/** Unicode combining marks (U+0300-U+036F), stripped after NFKD so "Acme" with
 *  a ring above slugs as "acme". Built from code points so the range survives
 *  source-file normalization intact. */
const COMBINING_MARKS = new RegExp(
  `[${String.fromCharCode(0x300)}-${String.fromCharCode(0x36f)}]`,
  "g",
);

/**
 * Best-effort handle from a display name, for when the caller supplies none.
 *
 * Returns null rather than a fallback when the name yields nothing usable (an
 * all-emoji name, or one that slugifies to under the minimum). The caller then
 * fails loud and asks for an explicit handle — silently substituting the record
 * id would hand back a URL the user never chose and cannot guess.
 */
export function deriveSlug(name: string): string | null {
  const slug = name
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/g, "");

  return slug.length < SLUG_MIN_LENGTH ? null : slug;
}
