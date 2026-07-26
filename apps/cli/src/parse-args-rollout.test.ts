import { describe, expect, it } from "vitest";
import { parseInvocation } from "./parse-args.js";

/**
 * `--rollout` is a percentage that moves production traffic, so every input that
 * is not plainly a number 0-100 or "none" has to fail loud. The dangerous inputs
 * are the ones JavaScript coerces for free: `Number("")` and `Number(" ")` are
 * both 0, which would read as "roll out to nobody" instead of a usage error.
 */
function rolloutOf(value: string): number | null | undefined {
  return parseInvocation(["flags", "config", "--rollout", value]).flags.rollout;
}

describe("--rollout parsing", () => {
  it("accepts a whole percentage", () => {
    expect(rolloutOf("25")).toBe(25);
  });

  it("accepts a fractional percentage", () => {
    expect(rolloutOf("33.5")).toBe(33.5);
  });

  it("accepts the 0 and 100 boundaries", () => {
    expect(rolloutOf("0")).toBe(0);
    expect(rolloutOf("100")).toBe(100);
  });

  it('maps "none" to null so the baseline can be cleared', () => {
    expect(rolloutOf("none")).toBeNull();
  });

  it("leaves rollout undefined when the flag is absent", () => {
    expect(parseInvocation(["flags", "config"]).flags.rollout).toBeUndefined();
  });

  it("rejects a whitespace-only value instead of coercing it to 0", () => {
    expect(() => rolloutOf(" ")).toThrow(/--rollout must be a number 0-100/);
  });

  it("rejects a non-numeric value", () => {
    expect(() => rolloutOf("half")).toThrow(/--rollout must be a number 0-100/);
  });

  it("rejects out-of-range percentages", () => {
    expect(() => rolloutOf("101")).toThrow(/--rollout must be a number 0-100/);
    expect(() => rolloutOf("-1")).toThrow(/--rollout must be a number 0-100/);
  });
});
