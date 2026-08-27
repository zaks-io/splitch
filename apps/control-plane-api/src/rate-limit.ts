import type { RateLimitClass } from "@splitch/contracts";
import type { RateLimiter } from "@splitch/worker-runtime";

const RETRY_AFTER_MS = 60_000;

/**
 * Data-plane classes the Evaluation surface already applied before the hop.
 * This Worker only owns the actor limiter; throwing here fail-closes every
 * Convex/Cloudflare install as a 429 with a placeholder retryAfterMs (SPL-449).
 */
const SURFACE_RATE_LIMIT_CLASSES = new Set<Exclude<RateLimitClass, "none">>([
  "api-key",
  "client-key",
]);

const allowRuntimeRateLimiter: RateLimiter = () => ({ limited: false });

export function rateLimiterForTarget(
  target: string | undefined,
  actorRateLimiter: RateLimit | undefined,
): RateLimiter {
  if (target === "local" || target === "shared-preview") return allowRuntimeRateLimiter;

  return async ({ class: rateLimitClass, principal }) => {
    if (SURFACE_RATE_LIMIT_CLASSES.has(rateLimitClass)) {
      return { limited: false };
    }
    if (rateLimitClass !== "control-plane-actor") {
      throw new Error(`control-plane-api: unsupported rate-limit class ${rateLimitClass}`);
    }
    if (!actorRateLimiter) {
      throw new Error("control-plane-api: actor rate-limit binding is not configured");
    }
    const { success } = await actorRateLimiter.limit({
      key: `${principal.kind}:${principal.id}`,
    });
    return success ? { limited: false } : { limited: true, retryAfterMs: RETRY_AFTER_MS };
  };
}
