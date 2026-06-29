import { describe, expect, it } from "vitest";
import { REDACTED } from "./redaction-rules.js";
import { redactValuePatterns } from "./value-patterns.js";

describe("redactValuePatterns", () => {
  it("redacts a bare email anywhere in a string", () => {
    const out = redactValuePatterns("contact leak@evil.com for help");
    expect(out.includes("leak@evil.com")).toBe(false);
    expect(out.includes(REDACTED)).toBe(true);
    expect(out.includes("for help")).toBe(true);
  });

  it("redacts a phone-like run of digits", () => {
    const out = redactValuePatterns("call 555-867-5309 now");
    expect(out.includes("555-867-5309")).toBe(false);
  });

  it("leaves short numbers (ids, counts) alone", () => {
    const out = redactValuePatterns("req-123 attempt 2 of 5");
    expect(out).toBe("req-123 attempt 2 of 5");
  });

  it("redacts app-specific shapes via extraPatterns (the Targeting Key)", () => {
    const out = redactValuePatterns("assign() failed for targetingKey tk-abc123", {
      extraPatterns: [/tk-[a-z0-9]+/gi],
    });
    expect(out.includes("tk-abc123")).toBe(false);
  });

  it("does not mutate a string with no PII shapes", () => {
    expect(redactValuePatterns("all good here")).toBe("all good here");
  });

  it("is reusable: a global extraPattern does not skip matches across calls", () => {
    const opts = { extraPatterns: [/tk-[a-z0-9]+/gi] };
    expect(redactValuePatterns("tk-one", opts).includes("tk-one")).toBe(false);
    expect(redactValuePatterns("tk-two", opts).includes("tk-two")).toBe(false);
  });

  // ReDoS regression: an adversarial domain with no valid TLD used to backtrack
  // quadratically. The bounded quantifiers keep it linear.
  it("handles adversarial no-TLD input fast and still redacts real emails", () => {
    const adversarial = `a@${"a.".repeat(40_000)}`;
    const start = performance.now();
    redactValuePatterns(adversarial);
    expect(performance.now() - start).toBeLessThan(50);

    for (const email of ["bob@example.com", "a.b+c@sub.domain.co.uk", "x@y.io"]) {
      expect(redactValuePatterns(`contact ${email}`).includes(email)).toBe(false);
    }
  });
});
