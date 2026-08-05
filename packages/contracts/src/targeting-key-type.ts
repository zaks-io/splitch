import { z } from "zod";

/**
 * Write-time shape for Experiment `targetingKeyType` (wire `idType`).
 *
 * Entity types are an open vocabulary — a Targeting Key may identify a user,
 * session, workspace, service, restaurant, driver, or another unit
 * (CONTEXT.md; apps/evaluation-api/CONTEXT.md). Create/patch therefore reject
 * typo-shaped values only: nonempty, lowercase, bounded charset, length cap.
 * Leaf and storage stay plain strings so historical rows remain readable.
 *
 * Underscore separates multi-segment labels (e.g. `service_account`). Hyphen is
 * reserved for slug handles (`SlugSchema`), which must never take an identifier
 * shape; Entity type labels are opaque tokens, not URL handles.
 */

export const TARGETING_KEY_TYPE_MAX_LENGTH = 63;

/** Lowercase alphanumerics with single internal underscores; no leading/trailing underscore. */
const TARGETING_KEY_TYPE_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

export const TARGETING_KEY_TYPE_SHAPE_MESSAGE =
  "must be lowercase alphanumerics separated by single underscores";

export const TargetingKeyTypeSchema = z
  .string()
  .min(1)
  .max(TARGETING_KEY_TYPE_MAX_LENGTH)
  .regex(TARGETING_KEY_TYPE_PATTERN, TARGETING_KEY_TYPE_SHAPE_MESSAGE);
