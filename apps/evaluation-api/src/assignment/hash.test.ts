import { describe, expect, it } from "vitest";
import { hashToUnitInterval } from "./hash.js";

/**
 * Golden raw-hash vectors. These are the cross-runtime PARITY anchors: any other
 * runtime or SDK language that reimplements FNV-1a (32-bit) + the lowbias32
 * finalizer over UTF-8 bytes MUST reproduce these exact unit-interval values. If
 * a refactor changes any number here, bucketing has silently shifted and every
 * existing assignment would move.
 */
const GOLDEN = [
  { input: "s1:userA", unit: 0.20568129513412714 },
  { input: "s1:userB", unit: 0.5936171186622232 },
  { input: "exp-salt:user-123", unit: 0.8061533011496067 },
  { input: "", unit: 0.4534318521618843 },
  { input: "salt:", unit: 0.2730446907225996 },
  { input: ":key", unit: 0.06997855962254107 },
  // Multi-byte UTF-8 must hash by bytes, identically everywhere.
  { input: "🚀:emoji-user", unit: 0.6606799818109721 },
] as const;

describe("hashToUnitInterval", () => {
  it("matches golden vectors exactly (cross-runtime parity anchor)", () => {
    for (const { input, unit } of GOLDEN) {
      expect(hashToUnitInterval(input)).toBe(unit);
    }
  });

  it("is deterministic across repeated calls", () => {
    for (const { input } of GOLDEN) {
      expect(hashToUnitInterval(input)).toBe(hashToUnitInterval(input));
    }
  });

  it("always lands in the half-open interval [0, 1)", () => {
    for (let i = 0; i < 5000; i++) {
      const value = hashToUnitInterval(`probe-${i}`);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it("distinguishes inputs that differ only past the colon", () => {
    expect(hashToUnitInterval("s1:userA")).not.toBe(hashToUnitInterval("s1:userB"));
  });
});
