import { getRoute } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import {
  classifySrmRootCause,
  type SrmRootCauseBranch,
  type SrmRootCauseInput,
  SRM_ROOT_CAUSE_NEXT_CHECK,
  SRM_ROOT_CAUSE_TELEMETRY_GAPS,
} from "./srm-root-cause";

describe("classifySrmRootCause", () => {
  it.each(branchCases())("$name -> $expectedBranch", ({ input, expectedBranch, nextCheck }) => {
    const result = classifySrmRootCause(input);
    if (expectedBranch === null) {
      expect(result).toBeNull();
      return;
    }
    expect(result?.branch).toBe(expectedBranch);
    expect(result?.nextCheck).toBe(nextCheck);
    expect(result?.explanation.length).toBeGreaterThan(0);
  });

  it("every branch nextCheck resolves to a registered routeRegistry operation", () => {
    for (const { input, expectedBranch } of branchCases()) {
      if (expectedBranch === null) continue;
      const result = classifySrmRootCause(input);
      if (result === null) {
        throw new Error(`expected classification for ${expectedBranch}`);
      }
      expect(getRoute(result.nextCheck), result.nextCheck).toBeDefined();
    }
  });

  it("triggered_only explanation names the Activation gate", () => {
    const result = classifySrmRootCause({
      exposureMismatch: false,
      activatedMismatch: true,
    });
    expect(result?.explanation).toContain("Activation gate");
  });

  it("segment_localized explanation names the mismatched slice", () => {
    const result = classifySrmRootCause({
      exposureMismatch: true,
      activatedMismatch: false,
      segmentCuts: [
        { dimensionId: "country", dimensionValue: "US", srmIsMismatch: true },
        { dimensionId: "country", dimensionValue: "DE", srmIsMismatch: false },
      ],
    });
    expect(result?.explanation).toContain("country=US");
  });

  it("unclassified carries the evidence weighed, never a guess", () => {
    const result = classifySrmRootCause({
      exposureMismatch: true,
      activatedMismatch: false,
    });
    expect(result).toEqual({
      branch: "unclassified",
      explanation:
        "Sample Ratio Mismatch fired, but the available signals do not isolate a single Fabijan branch.",
      nextCheck: SRM_ROOT_CAUSE_NEXT_CHECK,
      evidenceConsidered: [
        "exposure_srm:mismatch",
        "activated_srm:clean",
        "segment_cuts:absent",
        "day_buckets:absent",
      ],
    });
  });

  it("unclassified when triggered_only and segment_localized conflict", () => {
    const result = classifySrmRootCause({
      exposureMismatch: false,
      activatedMismatch: true,
      segmentCuts: [
        { dimensionId: "device", dimensionValue: "mobile", srmIsMismatch: true },
        { dimensionId: "device", dimensionValue: "desktop", srmIsMismatch: false },
      ],
    });
    expect(result?.branch).toBe("unclassified");
    expect(result?.evidenceConsidered).toContain(
      "conflicting_branches:triggered_only,segment_localized",
    );
  });

  it("singleton mismatching day stays unclassified (no vacuous later-day balance)", () => {
    const result = classifySrmRootCause({
      exposureMismatch: true,
      activatedMismatch: false,
      dayBuckets: [{ day: "2026-07-01", srmIsMismatch: true }],
    });
    expect(result?.branch).toBe("unclassified");
    expect(result?.evidenceConsidered).toContain("day_buckets:mismatched_1_of_1");
  });

  it("lists engagement_direction and latency_linked as telemetry gaps, never as branches", () => {
    expect(SRM_ROOT_CAUSE_TELEMETRY_GAPS.map((gap) => gap.branch)).toEqual([
      "engagement_direction",
      "latency_linked",
    ]);
    const result = classifySrmRootCause({
      exposureMismatch: true,
      activatedMismatch: false,
    });
    expect(result?.branch).toBe("unclassified");
    expect(JSON.stringify(result)).not.toContain("engagement_direction");
    expect(JSON.stringify(result)).not.toContain("latency_linked");
  });

  it("fails loud on malformed segment or day inputs", () => {
    expect(() =>
      classifySrmRootCause({
        exposureMismatch: true,
        activatedMismatch: false,
        segmentCuts: [{ dimensionId: " ", dimensionValue: "us", srmIsMismatch: true }],
      }),
    ).toThrow(/segmentCuts\[0\] requires non-empty/);
    expect(() =>
      classifySrmRootCause({
        exposureMismatch: true,
        activatedMismatch: false,
        dayBuckets: [{ day: "", srmIsMismatch: true }],
      }),
    ).toThrow(/dayBuckets\[0\]\.day must be a non-empty string/);
  });
});

function branchCases(): Array<{
  name: string;
  input: SrmRootCauseInput;
  expectedBranch: SrmRootCauseBranch | null;
  nextCheck?: string;
}> {
  return [
    {
      name: "no SRM fired",
      input: { exposureMismatch: false, activatedMismatch: false },
      expectedBranch: null,
    },
    {
      name: "no SRM and no activation gate",
      input: { exposureMismatch: false, activatedMismatch: null },
      expectedBranch: null,
    },
    {
      name: "triggered_only when activated fires and Exposure is clean",
      input: { exposureMismatch: false, activatedMismatch: true },
      expectedBranch: "triggered_only",
      nextCheck: SRM_ROOT_CAUSE_NEXT_CHECK,
    },
    {
      name: "segment_localized when a proper subset of cuts mismatch",
      input: {
        exposureMismatch: true,
        activatedMismatch: false,
        segmentCuts: [
          { dimensionId: "country", dimensionValue: "US", srmIsMismatch: true },
          { dimensionId: "country", dimensionValue: "DE", srmIsMismatch: false },
          { dimensionId: "country", dimensionValue: "FR", srmIsMismatch: false },
        ],
      },
      expectedBranch: "segment_localized",
      nextCheck: SRM_ROOT_CAUSE_NEXT_CHECK,
    },
    {
      name: "day_one when only the first Exposure day mismatches",
      input: {
        exposureMismatch: true,
        activatedMismatch: false,
        dayBuckets: [
          { day: "2026-07-01", srmIsMismatch: true },
          { day: "2026-07-02", srmIsMismatch: false },
          { day: "2026-07-03", srmIsMismatch: false },
        ],
      },
      expectedBranch: "day_one",
      nextCheck: SRM_ROOT_CAUSE_NEXT_CHECK,
    },
    {
      name: "unclassified when Exposure fires without localizing signals",
      input: { exposureMismatch: true, activatedMismatch: false },
      expectedBranch: "unclassified",
      nextCheck: SRM_ROOT_CAUSE_NEXT_CHECK,
    },
    {
      name: "unclassified when every segment cut mismatches",
      input: {
        exposureMismatch: true,
        activatedMismatch: false,
        segmentCuts: [
          { dimensionId: "country", dimensionValue: "US", srmIsMismatch: true },
          { dimensionId: "country", dimensionValue: "DE", srmIsMismatch: true },
        ],
      },
      expectedBranch: "unclassified",
      nextCheck: SRM_ROOT_CAUSE_NEXT_CHECK,
    },
    {
      name: "unclassified when day-one and a later day both mismatch",
      input: {
        exposureMismatch: true,
        activatedMismatch: false,
        dayBuckets: [
          { day: "2026-07-01", srmIsMismatch: true },
          { day: "2026-07-02", srmIsMismatch: true },
        ],
      },
      expectedBranch: "unclassified",
      nextCheck: SRM_ROOT_CAUSE_NEXT_CHECK,
    },
    {
      name: "unclassified for a singleton mismatching day (no later scored day)",
      input: {
        exposureMismatch: true,
        activatedMismatch: false,
        dayBuckets: [{ day: "2026-07-01", srmIsMismatch: true }],
      },
      expectedBranch: "unclassified",
      nextCheck: SRM_ROOT_CAUSE_NEXT_CHECK,
    },
    {
      name: "unclassified when both Exposure and activated SRM fire without slices",
      input: { exposureMismatch: true, activatedMismatch: true },
      expectedBranch: "unclassified",
      nextCheck: SRM_ROOT_CAUSE_NEXT_CHECK,
    },
  ];
}
