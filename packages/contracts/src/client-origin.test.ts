import { describe, expect, it } from "vitest";
import { normalizeClientOrigins, OriginAllowlistSchema } from "./client-origin";

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
});
