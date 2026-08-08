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

  it("preserves a UUID Targeting Key", () => {
    const id = "550e8400-e29b-41d4-a716-446655440000";
    expect(redactValuePatterns(id)).toBe(id);
  });

  it("preserves a hyphenated minted id with a phone-like numeric suffix", () => {
    const id = "apr_01J00000000000000000000000-1234567890";
    expect(redactValuePatterns(id)).toBe(id);
  });

  it("preserves a req-shaped id with a phone-like numeric suffix", () => {
    const id = "req-1234567890";
    expect(redactValuePatterns(id)).toBe(id);
  });

  it("still redacts a phone preceded by a hyphen in prose", () => {
    expect(redactValuePatterns("call me at -555 123 4567")).toBe(`call me at -555 ${REDACTED}`);
  });

  // SPL-360: phone matches must not start after a word character. Removing the
  // lookbehind turns each of these red (mid-token digit runs get eaten).
  it("preserves opaque tokens whose bodies look phone-like (leak probes)", () => {
    for (const message of [
      "lookup failed for user_15551234567",
      "lookup failed for app_18005551212",
      "lookup failed for org_5558675309",
    ]) {
      expect(redactValuePatterns(message)).toBe(message);
    }
  });

  it("redacts a bare phone after a ULID-shaped id without eating the id", () => {
    const id = "apr_01J1234567";
    expect(redactValuePatterns(`${id} 555-867-5309`)).toBe(`${id} ${REDACTED}`);
  });

  it("redacts a parenthesized phone after a flag id without eating the id", () => {
    // Leading `(` precedes the digit run, so it survives — same as main.
    expect(redactValuePatterns("flag_0123456789 (555) 867-5309")).toBe(
      `flag_0123456789 (${REDACTED}`,
    );
  });

  it("preserves a multi-segment opaque token with a long digit run", () => {
    const id = "rule_segment_0123456789ab";
    expect(redactValuePatterns(`failed for ${id}`)).toBe(`failed for ${id}`);
  });

  it("still redacts bare international phones and JSON-embedded phones", () => {
    expect(redactValuePatterns("+15551234567").includes("+15551234567")).toBe(false);
    expect(redactValuePatterns("+44 20 7946 0958").includes("+44 20 7946 0958")).toBe(false);
    const embedded = redactValuePatterns('{"phone":"+15551234567"}');
    expect(embedded.includes("+15551234567")).toBe(false);
    expect(embedded.includes(REDACTED)).toBe(true);
  });

  it("scrubs a large opaque token under a fixed budget", () => {
    // Large single opaque token: lookbehind yields zero phone matches, so the
    // walk stays near-linear in input length. An outward per-match token scan
    // only runs when there are matches; match-adjacent word-char tails are also
    // email-local runs that dominate timing before that scan can, so this
    // fixture does not claim to catch scan reintroduction.
    const hexChunk = "a1b2c3d4e5f67890";
    const body = hexChunk.repeat(Math.ceil(100_000 / hexChunk.length)).slice(0, 100_000);
    const input = `payload_${body}`;
    expect(input.length).toBe(8 + 100_000);

    const start = performance.now();
    const out = redactValuePatterns(input);
    const elapsedMs = performance.now() - start;
    expect(out).toBe(input);
    expect(elapsedMs).toBeLessThan(250);
  });

  it("redacts app-specific shapes via extraPatterns (the Targeting Key)", () => {
    const out = redactValuePatterns("assign() failed for targetingKey tk-abc123", {
      extraPatterns: [/tk-[a-z0-9]+/gi],
    });
    expect(out.includes("tk-abc123")).toBe(false);
  });

  it("redacts with a sticky extraPattern on every call (clone isolates lastIndex)", () => {
    const sticky = /tk-[a-z0-9]+/y;
    const opts = { extraPatterns: [sticky] };
    expect(redactValuePatterns("tk-abc123", opts).includes("tk-abc123")).toBe(false);
    expect(redactValuePatterns("tk-abc123", opts).includes("tk-abc123")).toBe(false);
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
