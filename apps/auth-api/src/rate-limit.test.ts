import { describe, expect, it } from "vitest";
import { OAuthError } from "./oauth-errors";
import { makeRateLimiter } from "./rate-limit";

/**
 * Focused guards on the anon-create rate ceiling (ADR-0034 §4). Both the per-IP
 * cap and the GLOBAL cap (the IP-rotation backstop) must trip with
 * `too_many_requests`, and the window must roll over after an hour.
 */

const T0 = 1_780_000_000_000;
const HOUR = 60 * 60 * 1000;

function expectCeiling(fn: () => void): void {
  try {
    fn();
    throw new Error("expected a rate-ceiling throw");
  } catch (e) {
    expect(e).toBeInstanceOf(OAuthError);
    expect((e as OAuthError).code).toBe("too_many_requests");
    expect((e as OAuthError).status).toBe(429);
  }
}

describe("makeRateLimiter", () => {
  it("trips the per-IP ceiling on the (N+1)th create from one IP", () => {
    const limiter = makeRateLimiter({ perIpPerHour: 2, globalPerHour: 1000 });
    limiter.assertUnderCeiling("1.1.1.1", T0);
    limiter.assertUnderCeiling("1.1.1.1", T0);
    expectCeiling(() => limiter.assertUnderCeiling("1.1.1.1", T0));
  });

  it("trips the GLOBAL ceiling even when each IP is individually under its cap", () => {
    const limiter = makeRateLimiter({ perIpPerHour: 100, globalPerHour: 2 });
    limiter.assertUnderCeiling("a", T0);
    limiter.assertUnderCeiling("b", T0);
    // 3rd create from a brand-new IP: per-IP is fine, but the global cap trips.
    expectCeiling(() => limiter.assertUnderCeiling("c", T0));
  });

  it("rolls the window over after an hour", () => {
    const limiter = makeRateLimiter({ perIpPerHour: 1, globalPerHour: 1000 });
    limiter.assertUnderCeiling("1.1.1.1", T0);
    expectCeiling(() => limiter.assertUnderCeiling("1.1.1.1", T0));
    // An hour later the per-IP window resets.
    limiter.assertUnderCeiling("1.1.1.1", T0 + HOUR);
  });
});
