import { describe, expect, it } from "vitest";
import {
  classifyRopeVerdict,
  type RopeScale,
  type RopeVerdict,
  type RopeVerdictInput,
} from "./rope-verdict";

describe("classifyRopeVerdict", () => {
  it.each(verdictCases())(
    "$name ($scale) -> $expected",
    ({ scale, lower, upper, ropeLower, ropeUpper, expected }) => {
      expect(
        classifyRopeVerdict({
          scale,
          lower,
          upper,
          ropeLower,
          ropeUpper,
        }),
      ).toBe(expected);
    },
  );

  it("treats closed-interval boundary equality consistently", () => {
    const rope = { ropeLower: -1, ropeUpper: 1 } as const;

    // Point on either ROPE bound is inside the closed ROPE.
    expect(classifyRopeVerdict({ scale: "absolute", lower: -1, upper: -1, ...rope })).toBe(
      "inside",
    );
    expect(classifyRopeVerdict({ scale: "absolute", lower: 1, upper: 1, ...rope })).toBe("inside");

    // Touching the ROPE from outside shares a point, so not outside.
    expect(classifyRopeVerdict({ scale: "absolute", lower: -3, upper: -1, ...rope })).toBe(
      "undecided",
    );
    expect(classifyRopeVerdict({ scale: "absolute", lower: 1, upper: 3, ...rope })).toBe(
      "undecided",
    );

    // Strict separation is outside.
    expect(classifyRopeVerdict({ scale: "absolute", lower: -3, upper: -1.0001, ...rope })).toBe(
      "outside",
    );
    expect(classifyRopeVerdict({ scale: "absolute", lower: 1.0001, upper: 3, ...rope })).toBe(
      "outside",
    );
  });

  it("keeps the verdict when absolute and relative use matching numbers", () => {
    const absolute = classifyRopeVerdict({
      scale: "absolute",
      lower: 0.02,
      upper: 0.05,
      ropeLower: -0.01,
      ropeUpper: 0.01,
    });
    const relative = classifyRopeVerdict({
      scale: "relative",
      lower: 2,
      upper: 5,
      ropeLower: -1,
      ropeUpper: 1,
    });
    expect(absolute).toBe("outside");
    expect(relative).toBe("outside");
  });

  it("fails loud on non-finite bounds", () => {
    expect(() => classifyRopeVerdict(base({ lower: Number.NaN }))).toThrow(
      /lower must be a finite number/,
    );
    expect(() => classifyRopeVerdict(base({ upper: Number.POSITIVE_INFINITY }))).toThrow(
      /upper must be a finite number/,
    );
    expect(() => classifyRopeVerdict(base({ ropeLower: Number.NEGATIVE_INFINITY }))).toThrow(
      /ropeLower must be a finite number/,
    );
    expect(() => classifyRopeVerdict(base({ ropeUpper: Number.NaN }))).toThrow(
      /ropeUpper must be a finite number/,
    );
  });

  it("fails loud when the interval is inverted", () => {
    expect(() => classifyRopeVerdict(base({ lower: 2, upper: 1 }))).toThrow(
      /interval lower \(2\) must be <= upper \(1\)/,
    );
  });

  it("fails loud when the ROPE is empty or inverted", () => {
    expect(() => classifyRopeVerdict(base({ ropeLower: 0, ropeUpper: 0 }))).toThrow(
      /ROPE lower \(0\) must be strictly less than ROPE upper \(0\)/,
    );
    expect(() => classifyRopeVerdict(base({ ropeLower: 1, ropeUpper: -1 }))).toThrow(
      /ROPE lower \(1\) must be strictly less than ROPE upper \(-1\)/,
    );
  });

  it("fails loud on an unknown scale", () => {
    expect(() => classifyRopeVerdict(base({ scale: "percent" as RopeScale }))).toThrow(
      /ROPE scale must be "absolute" or "relative"/,
    );
  });

  it("property: random valid inputs yield exactly one of the three verdicts", () => {
    const random = seededRandom(2_026_100_2);
    for (let i = 0; i < 200; i += 1) {
      const scale: RopeScale = random() < 0.5 ? "absolute" : "relative";
      const a = randomBetween(random, -50, 50);
      const b = randomBetween(random, -50, 50);
      const c = randomBetween(random, -50, 50);
      const d = randomBetween(random, -50, 50);
      const lower = Math.min(a, b);
      const upper = Math.max(a, b);
      const ropeLower = Math.min(c, d);
      const ropeSpan = Math.max(c, d);
      const ropeUpper = ropeLower === ropeSpan ? ropeLower + 0.25 : ropeSpan;
      const verdict = classifyRopeVerdict({ scale, lower, upper, ropeLower, ropeUpper });
      expect(["outside", "inside", "undecided"]).toContain(verdict);
      expect(matchesGeometry(verdict, lower, upper, ropeLower, ropeUpper)).toBe(true);
    }
  });
});

function verdictCases(): ReadonlyArray<{
  readonly name: string;
  readonly scale: RopeScale;
  readonly lower: number;
  readonly upper: number;
  readonly ropeLower: number;
  readonly ropeUpper: number;
  readonly expected: RopeVerdict;
}> {
  return [
    {
      name: "entirely below ROPE",
      scale: "absolute",
      lower: -0.08,
      upper: -0.03,
      ropeLower: -0.01,
      ropeUpper: 0.01,
      expected: "outside",
    },
    {
      name: "entirely above ROPE",
      scale: "relative",
      lower: 3,
      upper: 8,
      ropeLower: -2,
      ropeUpper: 2,
      expected: "outside",
    },
    {
      name: "interval equals ROPE",
      scale: "absolute",
      lower: -0.01,
      upper: 0.01,
      ropeLower: -0.01,
      ropeUpper: 0.01,
      expected: "inside",
    },
    {
      name: "strictly inside ROPE",
      scale: "relative",
      lower: -0.5,
      upper: 0.4,
      ropeLower: -2,
      ropeUpper: 2,
      expected: "inside",
    },
    {
      name: "overlaps lower bound only",
      scale: "absolute",
      lower: -0.05,
      upper: 0,
      ropeLower: -0.01,
      ropeUpper: 0.01,
      expected: "undecided",
    },
    {
      name: "overlaps upper bound only",
      scale: "relative",
      lower: 0,
      upper: 5,
      ropeLower: -2,
      ropeUpper: 2,
      expected: "undecided",
    },
    {
      name: "interval contains ROPE",
      scale: "absolute",
      lower: -0.05,
      upper: 0.05,
      ropeLower: -0.01,
      ropeUpper: 0.01,
      expected: "undecided",
    },
    {
      name: "zero-width interval inside ROPE",
      scale: "relative",
      lower: 0,
      upper: 0,
      ropeLower: -1,
      ropeUpper: 1,
      expected: "inside",
    },
    {
      name: "zero-width interval outside ROPE",
      scale: "absolute",
      lower: 0.05,
      upper: 0.05,
      ropeLower: -0.01,
      ropeUpper: 0.01,
      expected: "outside",
    },
  ];
}

function base(overrides: Partial<RopeVerdictInput> = {}): RopeVerdictInput {
  return {
    scale: "absolute",
    lower: -0.5,
    upper: 0.5,
    ropeLower: -1,
    ropeUpper: 1,
    ...overrides,
  };
}

function matchesGeometry(
  verdict: RopeVerdict,
  lower: number,
  upper: number,
  ropeLower: number,
  ropeUpper: number,
): boolean {
  const inside = lower >= ropeLower && upper <= ropeUpper;
  const outside = upper < ropeLower || lower > ropeUpper;
  if (verdict === "inside") return inside;
  if (verdict === "outside") return outside;
  return !inside && !outside;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function randomBetween(random: () => number, min: number, max: number): number {
  return min + (max - min) * random();
}
