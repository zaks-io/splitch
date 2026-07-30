import type { ScrubOptions } from "@splitch/privacy";

/**
 * Default bare-value patterns for observability emission. Targeting Keys are
 * opaque per App; this catches the repo's `tk-` test canary shape and common
 * splitch prefixes until a Worker overrides via `scrubOptions`.
 */
export const OBSERVABILITY_SCRUB_OPTIONS: ScrubOptions = {
  extraPatterns: [
    /tk-[a-z0-9-]+/gi,
    /spl_[a-z0-9_-]{16,}/gi,
    /sk_[a-f0-9]{64}/gi,
    /pk_[a-f0-9]{64}/gi,
  ],
};
