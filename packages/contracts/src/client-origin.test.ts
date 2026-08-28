import { describe, expect, it } from "vitest";
import { normalizeClientOrigins, OriginAllowlistSchema } from "./client-origin";
import { PERSISTED_ARRAY_MAX_ITEMS, PERSISTED_ORIGIN_MAX_LENGTH } from "./persisted-field-limits";

describe("OriginAllowlistSchema", () => {
  it("normalizes paths and removes duplicate origins", () => {
    expect(
      normalizeClientOrigins([
        "https://app.example.com/path",
        "https://app.example.com/other",
        "http://localhost:3000/path",
      ]),
    ).toEqual(["https://app.example.com", "http://localhost:3000"]);
  });

  it.each(["null", "*", "not a URL", "http://app.example.com"] as const)("rejects %s", (origin) => {
    expect(OriginAllowlistSchema.safeParse([origin]).success).toBe(false);
  });

  it("rejects an empty allowlist", () => {
    expect(OriginAllowlistSchema.safeParse([]).success).toBe(false);
  });

  it("rejects an origin over the named length bound", () => {
    const base = "https://example.com/";
    const atBound = `${base}${"a".repeat(PERSISTED_ORIGIN_MAX_LENGTH - base.length)}`;
    expect(OriginAllowlistSchema.safeParse([atBound]).success).toBe(true);
    expect(OriginAllowlistSchema.safeParse([`${atBound}x`]).success).toBe(false);
  });

  it("rejects more origins than the named array bound", () => {
    const origins = Array.from(
      { length: PERSISTED_ARRAY_MAX_ITEMS + 1 },
      (_, index) => `https://ex${index}.example`,
    );
    expect(OriginAllowlistSchema.safeParse(origins).success).toBe(false);
  });
});
