import { describe, expect, it } from "vitest";
import { assertFlagChangeWindow, parseChangeCursor } from "./flag-change-query";

describe("assertFlagChangeWindow", () => {
  it("compares from/to as instants so offset windows are not inverted by string order", () => {
    // String order says from < to (T10... < T12...), but from is 15:00Z and to
    // is 12:00Z, so the window is inverted on the timeline.
    expect(
      assertFlagChangeWindow(
        {
          from: "2026-08-25T10:00:00-05:00",
          to: "2026-08-25T12:00:00Z",
        },
        false,
      ),
    ).toBe("to must be at or after from");
  });

  it("accepts an offset window that is ordered by instant", () => {
    expect(
      assertFlagChangeWindow(
        {
          from: "2026-08-25T00:00:00-05:00",
          to: "2026-08-25T12:00:00Z",
        },
        false,
      ),
    ).toBeNull();
  });
});

describe("parseChangeCursor", () => {
  it("accepts a positive safe integer cursor", () => {
    expect(parseChangeCursor("1")).toBe(1);
    expect(parseChangeCursor(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("rejects digit strings that overflow or round past the safe integer range", () => {
    expect(parseChangeCursor("9".repeat(309))).toBe("invalid");
    expect(parseChangeCursor(String(Number.MAX_SAFE_INTEGER + 1))).toBe("invalid");
    expect(parseChangeCursor("9007199254740993")).toBe("invalid");
  });
});
