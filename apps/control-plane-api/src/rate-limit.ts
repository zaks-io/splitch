import type { RateLimiter } from "@splitch/worker-runtime";

const RETRY_AFTER_MS = 60_000;

const failClosedRateLimiter: RateLimiter = () => {
  throw new Error("control-plane-api: actor rate-limit binding is not configured");
};

const allowRuntimeRateLimiter: RateLimiter = () => ({ limited: false });

export function rateLimiterForTarget(
  target: string | undefined,
  actorRateLimiter: RateLimit | undefined,
): RateLimiter {
  if (target === "local" || target === "shared-preview") return allowRuntimeRateLimiter;
  if (!actorRateLimiter) return failClosedRateLimiter;

  return async ({ class: rateLimitClass, principal }) => {
    if (rateLimitClass !== "control-plane-actor") {
      throw new Error(`control-plane-api: unsupported rate-limit class ${rateLimitClass}`);
    }
    const { success } = await actorRateLimiter.limit({
      key: `${principal.kind}:${principal.id}`,
    });
    return success ? { limited: false } : { limited: true, retryAfterMs: RETRY_AFTER_MS };
  };
}
