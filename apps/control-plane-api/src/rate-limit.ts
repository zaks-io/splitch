import type { RateLimiter } from "@splitch/worker-runtime";

/**
 * Control-plane rate limiter.
 *
 * The real Cloudflare rate-limit binding for the `control-plane-actor` class is a
 * later slice. Until it lands, this limiter FAILS CLOSED (throws) for any guarded
 * class: the registrar maps a throwing limiter to RATE_LIMITED (429), never a
 * silent allow (worker-runtime.md step 4 — "Missing or throwing rate-limit
 * bindings fail closed for guarded routes"). A guarded route therefore stays
 * loudly unavailable rather than running unthrottled.
 */
export const failClosedRateLimiter: RateLimiter = () => {
  throw new Error("control-plane-api: rate-limit binding is not configured yet");
};
