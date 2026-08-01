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
