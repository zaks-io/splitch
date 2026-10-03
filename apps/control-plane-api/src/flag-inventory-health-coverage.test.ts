import { describe, expect, it } from "vitest";
import { FLAG_CHANGE_LOG_RETENTION_MS } from "./flag-change-log-retention";
import { changeLogCoverageStartsAt, monthChurnCoverage } from "./flag-inventory-health-coverage";

describe("changeLogCoverageStartsAt", () => {
  const asOf = "2026-07-02T12:00:00.000Z";
  const retentionBoundary = new Date(Date.parse(asOf) - FLAG_CHANGE_LOG_RETENTION_MS).toISOString();

  it("returns null when the App has no log rows", () => {
    expect(changeLogCoverageStartsAt(asOf, null)).toBeNull();
  });

  it("uses the retention floor when it is later than the earliest surviving row", () => {
    expect(changeLogCoverageStartsAt(asOf, "2026-01-01T00:00:00.000Z")).toBe(retentionBoundary);
  });

  it("uses the earliest surviving row when it is later than the retention floor", () => {
    expect(changeLogCoverageStartsAt(asOf, "2026-06-01T00:00:00.000Z")).toBe(
      "2026-06-01T00:00:00.000Z",
    );
  });
});

describe("monthChurnCoverage", () => {
  it("marks a month complete only when its UTC start is at or after coverage", () => {
    expect(monthChurnCoverage("2026-07", "2026-07-01T00:00:00.000Z")).toBe("complete");
    expect(monthChurnCoverage("2026-07", "2026-07-01T00:00:00.001Z")).toBe("partial");
    expect(monthChurnCoverage("2026-08", "2026-07-15T00:00:00.000Z")).toBe("complete");
  });
});
