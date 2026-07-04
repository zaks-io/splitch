import type { RateLimiter } from "@splitch/worker-runtime";

/**
 * Control-plane rate limiter.
 *
 * The real Cloudflare rate-limit binding for the `control-plane-actor` class is a
 * later slice. Until it lands, production still fails closed, but local and
 * shared-preview must allow requests so those environments can exercise real
 * Control Plane functionality.
 */
const failClosedRateLimiter: RateLimiter = () => {
  throw new Error("control-plane-api: rate-limit binding is not configured yet");
};

const allowRuntimeRateLimiter: RateLimiter = () => ({ limited: false });

export function rateLimiterForTarget(target: string | undefined): RateLimiter {
  return target === "local" || target === "shared-preview"
    ? allowRuntimeRateLimiter
    : failClosedRateLimiter;
}
