import { describe, expect, it } from "vitest";
import { scrubEmbeddedJson } from "./embedded-json.js";

// Fake scrubber: blanks out any `email` value, recursing through objects/arrays.
function blankEmails(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(blankEmails);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        k === "email" ? "[Redacted]" : blankEmails(v),
      ]),
    );
  }
  return value;
}

describe("scrubEmbeddedJson", () => {
  it("scrubs a JSON object embedded after a prose prefix", () => {
    const input = `failed for ${JSON.stringify({ email: "x@y.com", id: 1 })}`;
    const out = scrubEmbeddedJson(input, blankEmails);
    expect(out.includes("x@y.com")).toBe(false);
    expect(out.includes("failed for")).toBe(true);
    expect(out.includes('"id":1')).toBe(true);
  });

  it("leaves a brace that is not valid JSON untouched", () => {
    const input = "use {handlebars} syntax";
    expect(scrubEmbeddedJson(input, blankEmails)).toBe(input);
  });

  it("does not treat braces inside JSON strings as nesting", () => {
    const input = JSON.stringify({ note: "a } b { c", email: "z@z.com" });
    const out = scrubEmbeddedJson(input, blankEmails);
    expect(out.includes("z@z.com")).toBe(false);
    expect(out.includes("a } b { c")).toBe(true);
  });

  it("scrubs multiple embedded spans in one string", () => {
    const input = `a ${JSON.stringify({ email: "1@x.com" })} b ${JSON.stringify({ email: "2@x.com" })}`;
    const out = scrubEmbeddedJson(input, blankEmails);
    expect(out.includes("1@x.com")).toBe(false);
    expect(out.includes("2@x.com")).toBe(false);
  });

  it("returns prose with no JSON span unchanged", () => {
    expect(scrubEmbeddedJson("nothing here", blankEmails)).toBe("nothing here");
  });

  // Regression: a stray prose brace BEFORE the real JSON used to make the outer
  // span balance on the inner object's close, fail to parse, and skip the whole
  // region — leaking the inner JSON. The retry-from-next-brace fix catches it.
  it("scrubs JSON that follows a stray opening brace in prose", () => {
    const out = scrubEmbeddedJson('{not json {"email":"leak@evil.com"}', blankEmails);
    expect(out.includes("leak@evil.com")).toBe(false);
  });

  it("scrubs JSON wrapped by stray prose on both sides", () => {
    const out = scrubEmbeddedJson('{outer {"email":"leak@evil.com"} more', blankEmails);
    expect(out.includes("leak@evil.com")).toBe(false);
  });

  it("scrubs JSON after a stray bracket", () => {
    const out = scrubEmbeddedJson('[oops {"email":"leak@evil.com"}', blankEmails);
    expect(out.includes("leak@evil.com")).toBe(false);
  });

  // DoS regression: a long run of unparseable braces used to be O(n²) (each brace
  // rescanned to end-of-string). The length cap bounds the worst case.
  it("scrubs an adversarial brace-run string in well under 50ms", () => {
    const adversarial = "{".repeat(80_000);
    const start = performance.now();
    scrubEmbeddedJson(adversarial, blankEmails);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(50);
  });
});
