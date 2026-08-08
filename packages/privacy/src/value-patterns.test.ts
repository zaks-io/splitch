import { describe, expect, it } from "vitest";
import { REDACTED } from "./redaction-rules";
import { redactValuePatterns } from "./value-patterns";

/** ULID-shaped body whose randomness includes an 8-digit run the phone pattern matches. */
const DIGIT_RUN_ULID = "01J12345678ABCDEFGHJKMNPQR";
const MINTED_ID = `apr_${DIGIT_RUN_ULID}`;
const BARE_PHONE = "555-867-5309";
const BARE_DIGIT_RUN = "12345678901";
const BARE_EMAIL = "leak@evil.com";

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

  // SPL-360: phone-like defaults must not eat digit runs inside minted ids.
  // Each of these four goes red if the protection (or email/phone coverage) is
  // reverted — see the PR body for the raw failing output against main's pattern.
  it("preserves a minted internal id whose body has a long digit run", () => {
    const message = `${MINTED_ID}: Error: outer for ${MINTED_ID}`;
    expect(redactValuePatterns(message)).toBe(message);
  });

  it("still redacts a bare phone sitting immediately next to a minted internal id", () => {
    const out = redactValuePatterns(`${MINTED_ID}${BARE_PHONE}`);
    expect(out).toContain(MINTED_ID);
    expect(out.includes(BARE_PHONE)).toBe(false);
    expect(out.includes(REDACTED)).toBe(true);
  });

  it("still redacts an email when a minted internal id is also present", () => {
    const out = redactValuePatterns(`${MINTED_ID} contact ${BARE_EMAIL}`);
    expect(out).toContain(MINTED_ID);
    expect(out.includes(BARE_EMAIL)).toBe(false);
    expect(out.includes(REDACTED)).toBe(true);
  });

  it("still redacts a long digit run that is not a prefixed minted id", () => {
    const out = redactValuePatterns(`call ${BARE_DIGIT_RUN} now`);
    expect(out.includes(BARE_DIGIT_RUN)).toBe(false);
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
