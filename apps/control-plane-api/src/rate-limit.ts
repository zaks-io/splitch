import type { RateLimiter } from "@splitch/worker-runtime";

/**
 * Control-plane rate limiter.
 *
 * The real Cloudflare rate-limit binding for the `control-plane-actor` class is a
 * later slice. Until it lands, non-local targets FAIL CLOSED (throw) for any
 * guarded class: the registrar maps a throwing limiter to RATE_LIMITED (429),
 * never a silent allow (worker-runtime.md step 4 — "Missing or throwing
 * rate-limit bindings fail closed for guarded routes"). The local target is the
 * self-contained dev/test substrate and uses an explicit allow limiter.
 */
const failClosedRateLimiter: RateLimiter = () => {
  throw new Error("control-plane-api: rate-limit binding is not configured yet");
};

const allowLocalRateLimiter: RateLimiter = () => ({ limited: false });

export function rateLimiterForTarget(target: string | undefined): RateLimiter {
  return target === "local" ? allowLocalRateLimiter : failClosedRateLimiter;
}
