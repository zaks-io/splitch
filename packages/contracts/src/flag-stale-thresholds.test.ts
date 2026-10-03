import { describe, expect, it } from "vitest";
import { flagAgeBucket, FLAG_AGE_BUCKETS, FLAG_STALE_THRESHOLDS } from "./flag-stale-thresholds";

describe("FLAG_STALE_THRESHOLDS", () => {
  it("turns config-age signals off for permanent classes", () => {
    expect(FLAG_STALE_THRESHOLDS.ops).toEqual({
      uniformServingDays: null,
      unchangedDays: null,
    });
    expect(FLAG_STALE_THRESHOLDS.permission).toEqual({
      uniformServingDays: null,
      unchangedDays: null,
    });
    expect(FLAG_STALE_THRESHOLDS.release.uniformServingDays).toBe(30);
  });
});

describe("flagAgeBucket", () => {
  it("covers every non-negative age exactly once", () => {
    expect(flagAgeBucket(0)).toBe("0_30d");
    expect(flagAgeBucket(29.9)).toBe("0_30d");
    expect(flagAgeBucket(30)).toBe("30_90d");
    expect(flagAgeBucket(90)).toBe("90_180d");
    expect(flagAgeBucket(180)).toBe("180_365d");
    expect(flagAgeBucket(365)).toBe("365d_plus");
    expect(FLAG_AGE_BUCKETS).toHaveLength(5);
  });
});
