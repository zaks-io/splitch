import { describe, expect, it } from "vitest";
import { fractionalEval, type Rollout } from "./fractional-eval.js";

const TWO_WAY: Rollout = [
  { variantName: "control", weight: 50 },
  { variantName: "treatment", weight: 50 },
];

describe("fractionalEval", () => {
  it("is deterministic: same inputs always resolve to the same Variant", () => {
    for (const key of ["alice", "bob", "carol", "user-9000"]) {
      const first = fractionalEval("salt-a", key, TWO_WAY);
      expect(fractionalEval("salt-a", key, TWO_WAY)).toBe(first);
    }
  });

  it("a key never flips Variant across calls", () => {
    const key = "sticky-entity";
    const results = new Set<string>();
    for (let i = 0; i < 100; i++) {
      results.add(fractionalEval("flip-salt", key, TWO_WAY));
    }
    expect(results.size).toBe(1);
  });

  it("only the Targeting Key (with salt) drives the hash — rollout never does", () => {
    // Same salt + key but DIFFERENT rollout names: the hashed point is identical,
    // so the same fractional position is selected regardless of variant labels.
    const a: Rollout = [
      { variantName: "x", weight: 50 },
      { variantName: "y", weight: 50 },
    ];
    const b: Rollout = [
      { variantName: "p", weight: 50 },
      { variantName: "q", weight: 50 },
    ];
    // For a key whose point < 50 both pick the first share; whose point >= 50,
    // both pick the second. The fractional position is a pure function of salt+key.
    for (const key of ["k1", "k2", "k3", "k4", "k5"]) {
      const ra = fractionalEval("S", key, a);
      const rb = fractionalEval("S", key, b);
      const samePosition = (ra === "x") === (rb === "p");
      expect(samePosition).toBe(true);
    }
  });

  it("changing the salt re-buckets (salt is part of the hash identity)", () => {
    // Over a large key set a different salt MUST move some keys across the 50
    // boundary; an implementation that ignored the salt would flip zero.
    let flips = 0;
    for (let i = 0; i < 2000; i++) {
      const key = `entity-${i}`;
      if (fractionalEval("salt-one", key, TWO_WAY) !== fractionalEval("salt-two", key, TWO_WAY)) {
        flips++;
      }
    }
    expect(flips).toBeGreaterThan(0);
  });

  it("assigns every key to a real Variant for a 100% single-share rollout", () => {
    const single: Rollout = [{ variantName: "only", weight: 100 }];
    for (let i = 0; i < 1000; i++) {
      expect(fractionalEval("s", `k-${i}`, single)).toBe("only");
    }
  });

  it("uses half-open boundaries: the first share owns [0, w)", () => {
    // control owns [0, 50), treatment owns [50, 100). Golden keys span both.
    expect(fractionalEval("run-salt-xyz", "user-1", TWO_WAY)).toBe("control"); // point 26.40
    expect(fractionalEval("run-salt-xyz", "user-0", TWO_WAY)).toBe("treatment"); // point 57.13
  });
});
