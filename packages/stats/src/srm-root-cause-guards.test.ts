import { describe, expect, it } from "vitest";
import { classifySrmRootCause } from "./srm-root-cause";
import {
  SRM_ROOT_CAUSE_NEXT_CHECK,
  SRM_ROOT_CAUSE_SEGMENT_HOMOGENEITY_ALPHA,
  SRM_ROOT_CAUSE_TELEMETRY_GAPS,
} from "./srm-root-cause-types";

describe("classifySrmRootCause explanations", () => {
  it("triggered_only explanation names the Activation gate", () => {
    const result = classifySrmRootCause({
      exposureMismatch: false,
      activatedMismatch: true,
      activationCount: 400,
    });
    expect(result?.explanation).toContain("Activation gate");
  });

  it("zero Activations is insufficient evidence, not triggered_only", () => {
    const result = classifySrmRootCause({
      exposureMismatch: false,
      activatedMismatch: true,
      activationCount: 0,
    });
    expect(result?.branch).toBe("unclassified");
    expect(result?.explanation).toMatch(/insufficient evidence/i);
    expect(result?.explanation).toMatch(/zero Activations/i);
    expect(result?.evidenceConsidered).toContain("insufficient_evidence:zero_activations");
    expect(result?.evidenceConsidered).toContain("activation_count:0");
  });

  it("segment_localized explanation names the mismatched slice when proportions differ", () => {
    const result = classifySrmRootCause({
      exposureMismatch: true,
      activatedMismatch: false,
      activationCount: null,
      segmentCuts: [
        {
          dimensionId: "country",
          dimensionValue: "US",
          srmIsMismatch: true,
          observedCounts: { control: 7000, treatment: 3000 },
        },
        {
          dimensionId: "country",
          dimensionValue: "DE",
          srmIsMismatch: false,
          observedCounts: { control: 50, treatment: 50 },
        },
      ],
    });
    expect(result?.branch).toBe("segment_localized");
    expect(result?.explanation).toContain("country=US");
    expect(result?.explanation).toContain(`< ${SRM_ROOT_CAUSE_SEGMENT_HOMOGENEITY_ALPHA}`);
  });

  it("unequal-volume identical proportions do not claim segment_localized", () => {
    // US 6000/4000 and DE 60/40 share a 60/40 imbalance; only US crosses α.
    const result = classifySrmRootCause({
      exposureMismatch: true,
      activatedMismatch: false,
      activationCount: null,
      segmentCuts: [
        {
          dimensionId: "country",
          dimensionValue: "US",
          srmIsMismatch: true,
          observedCounts: { control: 6000, treatment: 4000 },
        },
        {
          dimensionId: "country",
          dimensionValue: "DE",
          srmIsMismatch: false,
          observedCounts: { control: 60, treatment: 40 },
        },
      ],
    });
    expect(result?.branch).toBe("unclassified");
    expect(result?.explanation).toContain("country=US");
    expect(result?.explanation).toMatch(/localization is not claimed/i);
    expect(result?.explanation).not.toMatch(/concentrated in/i);
    expect(result?.evidenceConsidered?.some((e) => e.includes("not_localized"))).toBe(true);
  });

  it("unclassified carries the evidence weighed, never a guess", () => {
    const result = classifySrmRootCause({
      exposureMismatch: true,
      activatedMismatch: false,
      activationCount: null,
    });
    expect(result).toEqual({
      branch: "unclassified",
      explanation:
        "Sample Ratio Mismatch fired, but the available signals do not isolate a single Fabijan branch.",
      nextCheck: SRM_ROOT_CAUSE_NEXT_CHECK,
      evidenceConsidered: [
        "exposure_srm:mismatch",
        "activated_srm:clean",
        "activation_count:absent",
        "segment_cuts:absent",
        "day_buckets:absent",
      ],
    });
  });
});

describe("classifySrmRootCause conflicts and telemetry gaps", () => {
  it("unclassified when triggered_only and segment_localized conflict", () => {
    const result = classifySrmRootCause({
      exposureMismatch: false,
      activatedMismatch: true,
      activationCount: 200,
      segmentCuts: [
        {
          dimensionId: "device",
          dimensionValue: "mobile",
          srmIsMismatch: true,
          observedCounts: { control: 700, treatment: 300 },
        },
        {
          dimensionId: "device",
          dimensionValue: "desktop",
          srmIsMismatch: false,
          observedCounts: { control: 50, treatment: 50 },
        },
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
      activationCount: null,
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
      activationCount: null,
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
        activationCount: null,
        segmentCuts: [{ dimensionId: " ", dimensionValue: "us", srmIsMismatch: true }],
      }),
    ).toThrow(/segmentCuts\[0\] requires non-empty/);
    expect(() =>
      classifySrmRootCause({
        exposureMismatch: true,
        activatedMismatch: false,
        activationCount: null,
        dayBuckets: [{ day: "", srmIsMismatch: true }],
      }),
    ).toThrow(/dayBuckets\[0\]\.day must be a non-empty string/);
    expect(() =>
      classifySrmRootCause({
        exposureMismatch: false,
        activatedMismatch: true,
        activationCount: -1,
      }),
    ).toThrow(/activationCount must be a non-negative integer/);
  });
});
