import { describe, expect, it } from "vitest";
import { assign } from "./assign";
import type { RunConfig } from "./run-config";

/**
 * A minimal valid RunConfig. Only the fields assign() reads (salt, allocation)
 * affect the result; the rest are present to keep the shape honest.
 */
function runConfig(salt: string, allocation: Record<string, number>): RunConfig {
  return {
    runId: "run-1",
    salt,
    allocation,
    variantSet: [],
    targetingRules: [],
    targetingKey: "userId",
  };
}

describe("assign", () => {
  describe("golden vectors (deterministic, cross-runtime parity)", () => {
    // 50/50 control/treatment, salt "run-salt-xyz". control owns [0,50),
    // treatment owns [50,100). Keys chosen to span BOTH buckets.
    const split = runConfig("run-salt-xyz", { control: 50, treatment: 50 });
    const GOLDEN_5050: Array<[string, string]> = [
      ["user-1", "control"], // point 26.40
      ["user-3", "control"], // point 46.40
      ["user-5", "control"], // point 39.72
      ["user-0", "treatment"], // point 57.13
      ["user-2", "treatment"], // point 53.60
      ["user-4", "treatment"], // point 65.36
    ];

    it.each(GOLDEN_5050)("assign(%s) === %s", (key, expected) => {
      expect(assign(split, key)).toBe(expected);
    });

    // 3-way a34/b33/c33, salt "s3". Golden keys land in each of the three arms.
    const threeWay = runConfig("s3", { a: 34, b: 33, c: 33 });
    const GOLDEN_3WAY: Array<[string, string]> = [
      ["k1", "a"], // point 2.83
      ["k0", "b"], // point 42.31
      ["k3", "c"], // point 89.39
    ];

    it.each(GOLDEN_3WAY)("3-way assign(%s) === %s", (key, expected) => {
      expect(assign(threeWay, key)).toBe(expected);
    });
  });

  it("same (salt, allocation, targetingKey) returns the same Variant across repeated calls", () => {
    const run = runConfig("repeat-salt", { control: 60, treatment: 40 });
    for (const key of ["a", "b", "c", "d", "e", "f"]) {
      const first = assign(run, key);
      for (let i = 0; i < 50; i++) {
        expect(assign(run, key)).toBe(first);
      }
    }
  });

  it("a key that lands in a bucket never flips Variant between calls", () => {
    const run = runConfig("no-flip", { control: 50, treatment: 50 });
    const observed = new Map<string, string>();
    for (let round = 0; round < 20; round++) {
      for (let i = 0; i < 200; i++) {
        const key = `entity-${i}`;
        const variant = assign(run, key);
        if (observed.has(key)) {
          expect(variant).toBe(observed.get(key));
        } else {
          observed.set(key, variant);
        }
      }
    }
  });

  it("allocation-record key order does not change the result (canonical ordering)", () => {
    const ascending = runConfig("order-salt", { control: 30, treatment: 70 });
    const descending = runConfig("order-salt", { treatment: 70, control: 30 });
    for (let i = 0; i < 500; i++) {
      const key = `o-${i}`;
      expect(assign(ascending, key)).toBe(assign(descending, key));
    }
  });

  describe("distribution over many keys", () => {
    const N = 50_000;
    // Generous tolerance: 1.5 percentage points absorbs ordinary hash variance
    // at this N while still catching a broken split (e.g. 50/50 vs 70/30).
    const TOLERANCE_PCT = 1.5;

    function distribution(allocation: Record<string, number>): Record<string, number> {
      const run = runConfig("dist-salt", allocation);
      const counts: Record<string, number> = {};
      for (let i = 0; i < N; i++) {
        const variant = assign(run, `subject-${i}`);
        counts[variant] = (counts[variant] ?? 0) + 1;
      }
      return counts;
    }

    it("a 70/30 split lands within tolerance of the configured allocation", () => {
      const counts = distribution({ control: 70, treatment: 30 });
      expect(Math.abs((100 * (counts.control ?? 0)) / N - 70)).toBeLessThan(TOLERANCE_PCT);
      expect(Math.abs((100 * (counts.treatment ?? 0)) / N - 30)).toBeLessThan(TOLERANCE_PCT);
    });

    it("an even 3-way split lands near 33.3% per arm", () => {
      const counts = distribution({ a: 34, b: 33, c: 33 });
      expect(Math.abs((100 * (counts.a ?? 0)) / N - 34)).toBeLessThan(TOLERANCE_PCT);
      expect(Math.abs((100 * (counts.b ?? 0)) / N - 33)).toBeLessThan(TOLERANCE_PCT);
      expect(Math.abs((100 * (counts.c ?? 0)) / N - 33)).toBeLessThan(TOLERANCE_PCT);
    });
  });

  // Regression guard for FNV-1a's weak avalanche on low-entropy keys. The hash
  // finalizer (hash.ts) exists so CONTIGUOUS integer Targeting Keys — autoincrement
  // user IDs, a very common targetingKey — do not produce a serially-correlated
  // ramp of bucket points. Without the finalizer, sequential keys at 50/50 yield
  // same-variant runs of 40-60 and a 200-id cohort split of ~40% (12pt off); both
  // assertions below FAIL on the pre-finalizer hash and PASS with it.
  describe("low-entropy sequential keys (avalanche regression guard)", () => {
    const COHORT = 200;
    // Contiguous integer keys "0".."199" — the worst case for a weak hash.
    function sequentialAssignments(): string[] {
      const run = runConfig("feature", { control: 50, treatment: 50 });
      return Array.from({ length: COHORT }, (_, i) => assign(run, `${i}`));
    }

    function longestRun(values: string[]): number {
      let longest = 0;
      let current = 0;
      let previous: string | null = null;
      for (const value of values) {
        current = value === previous ? current + 1 : 1;
        longest = Math.max(longest, current);
        previous = value;
      }
      return longest;
    }

    it("does not produce long same-variant runs over sequential keys", () => {
      // Pre-finalizer: 40-60. Post-finalizer: ~8-13. 20 cleanly separates them.
      expect(longestRun(sequentialAssignments())).toBeLessThanOrEqual(20);
    });

    it("a small sequential cohort splits near the configured 50/50", () => {
      const assignments = sequentialAssignments();
      const controls = assignments.filter((v) => v === "control").length;
      // Pre-finalizer drifts to ~40% (10pt off) at this N; post stays within 5pt.
      expect(Math.abs((100 * controls) / COHORT - 50)).toBeLessThan(5);
    });
  });
});
