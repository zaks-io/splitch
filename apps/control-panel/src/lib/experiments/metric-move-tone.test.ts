import { describe, expect, it } from "vitest";
import { moveTone } from "./metric-move-tone";

describe("moveTone", () => {
  it("reads a move only through the Metric's stated direction", () => {
    expect(moveTone({ direction: "higher_is_better", lift: 6.4, breached: false })).toBe("good");
    expect(moveTone({ direction: "higher_is_better", lift: -6.4, breached: false })).toBe("bad");
    expect(moveTone({ direction: "lower_is_better", lift: -32.3, breached: false })).toBe("good");
    expect(moveTone({ direction: "lower_is_better", lift: 280.8, breached: false })).toBe("bad");
  });

  it("stays neutral without a direction, an estimate, or a move", () => {
    expect(moveTone({ direction: null, lift: 280.8, breached: false })).toBe("neutral");
    expect(moveTone({ direction: undefined, lift: -50, breached: false })).toBe("neutral");
    expect(moveTone({ direction: "lower_is_better", lift: null, breached: false })).toBe("neutral");
    expect(moveTone({ direction: "lower_is_better", lift: 0, breached: false })).toBe("neutral");
  });

  it("lets a breached Guardrail outrank direction", () => {
    expect(moveTone({ direction: "lower_is_better", lift: -96.3, breached: true })).toBe(
      "breached",
    );
  });
});
