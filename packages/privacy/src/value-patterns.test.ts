import { describe, expect, it } from "vitest";
import { REDACTED } from "./redaction-rules";
import { redactValuePatterns } from "./value-patterns";

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

  // A ULID body can contain an 8+ digit run (~0.2% of mints). That run is not a
  // phone number; redacting it leaves a fault row unable to name what failed.
  it("preserves a minted internal id whose body has a long digit run", () => {
    const id = "apr_01J12345678ABCDEFGHJKMNPQR";
    const message = `${id}: Error: outer for ${id}`;
    expect(redactValuePatterns(message)).toBe(message);
  });

  it("preserves other minted-id prefixes with long digit runs", () => {
    for (const id of [
      "exp_01J12345678ABCDEFGHJKMNPQR",
      "flag_01J12345678ABCDEFGHJKMNPQR",
      "run_abcd12345678ef901234abcd",
    ]) {
      expect(redactValuePatterns(`failed for ${id}`)).toContain(id);
    }
  });

  it("still redacts a bare phone next to a preserved minted internal id", () => {
    const id = "apr_01J12345678ABCDEFGHJKMNPQR";
    const out = redactValuePatterns(`${id} call 555-867-5309`);
    expect(out).toContain(id);
    expect(out.includes("555-867-5309")).toBe(false);
    expect(out.includes(REDACTED)).toBe(true);
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
    // This guards ReDoS-scale regressions, not CI runner micro-benchmark speed.
    expect(performance.now() - start).toBeLessThan(1_000);

    for (const email of ["bob@example.com", "a.b+c@sub.domain.co.uk", "x@y.io"]) {
      expect(redactValuePatterns(`contact ${email}`).includes(email)).toBe(false);
    }
  });
});
