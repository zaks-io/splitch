import { describe, expect, it } from "vitest";
import { classifySrmRootCause } from "./srm-root-cause";
import { SRM_ROOT_CAUSE_FUTURE_BRANCHES, SRM_ROOT_CAUSE_NEXT_CHECK } from "./srm-root-cause-types";

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
      ],
    });
  });
});

describe("classifySrmRootCause future branches and validation", () => {
  it("lists day_one, segment_localized, engagement_direction, and latency_linked as future branches, never as emitted branches", () => {
    expect(SRM_ROOT_CAUSE_FUTURE_BRANCHES.map((gap) => gap.branch)).toEqual([
      "day_one",
      "segment_localized",
      "engagement_direction",
      "latency_linked",
    ]);
    const result = classifySrmRootCause({
      exposureMismatch: true,
      activatedMismatch: false,
      activationCount: null,
    });
    expect(result?.branch).toBe("unclassified");
    expect(JSON.stringify(result)).not.toContain("day_one");
    expect(JSON.stringify(result)).not.toContain("segment_localized");
    expect(JSON.stringify(result)).not.toContain("engagement_direction");
    expect(JSON.stringify(result)).not.toContain("latency_linked");
  });

  it("fails loud on malformed activationCount", () => {
    expect(() =>
      classifySrmRootCause({
        exposureMismatch: false,
        activatedMismatch: true,
        activationCount: -1,
      }),
    ).toThrow(/activationCount must be a non-negative integer/);
  });
});
