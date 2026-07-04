import type { RateLimitClass } from "@splitch/contracts";
import type { Principal } from "./principal";

/**
 * Decision returned by a rate-limit binding. `retryAfterMs` is required on a
 * limited result so the guard can render RATE_LIMITED details + the Retry-After
 * header from one place.
 */
export type RateLimitDecision = { limited: false } | { limited: true; retryAfterMs: number };

/**
 * Port a Worker implements to back the route's rate-limit class. The guard calls
 * it for every class other than `none`. Per the spec, a missing binding for a
 * guarded class, or a binding that throws, fails CLOSED — the request is rejected
 * as rate-limited, never let through.
 */
export type RateLimiter = (input: {
  class: Exclude<RateLimitClass, "none">;
  request: Request;
  principal: Principal;
}) => Promise<RateLimitDecision> | RateLimitDecision;
